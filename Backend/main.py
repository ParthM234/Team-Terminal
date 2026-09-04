"""
Sankhya Setu — quiz generation backend.

Two endpoints, called from the website:

  POST /generate-quiz   -> called when the user clicks "take a quiz".
                            Fetches their job details from Supabase,
                            asks an open-source LLM (via LangChain +
                            Hugging Face) for a 20-question MCQ quiz AND
                            a required-skill-level vector for their role,
                            stores both, and returns the quiz WITHOUT
                            the correct answers (those stay server-side).

  POST /submit-quiz     -> called when the user finishes the quiz.
                            Scores their answers against the stored
                            correct options, writes a skill_snapshots
                            row per skill, and returns the results.

Run locally with:
    uvicorn main:app --reload --port 8000

Environment variables needed (see .env.example):
    SUPABASE_URL
    SUPABASE_SERVICE_KEY   (service role key — NOT the anon key — this
                            backend needs to read/write on behalf of
                            users after verifying who they are)
    HF_TOKEN               (Hugging Face access token)
    HF_MODEL_REPO_ID        (default provided below)
"""

import os
import re
import json
import logging
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, ValidationError
from dotenv import load_dotenv
from supabase import create_client, Client

from langchain_huggingface import HuggingFaceEndpoint, ChatHuggingFace
from langchain_core.messages import HumanMessage, SystemMessage

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("quiz-backend")

# ============================================================
# Config
# ============================================================
SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
HF_TOKEN = os.environ["HF_TOKEN"]

# Ungated, widely-available instruct model as a starting point — swap
# this single value to try a different open-source model. Model
# availability on Hugging Face's serverless providers does shift over
# time, so if this one becomes unavailable, swap the repo_id here.
HF_MODEL_REPO_ID = os.environ.get("HF_MODEL_REPO_ID", "mistralai/Mistral-7B-Instruct-v0.3")

QUESTIONS_PER_QUIZ = 20
MAX_LLM_RETRIES = 3

supabase: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)

# HuggingFaceEndpoint is the raw client; ChatHuggingFace wraps it so
# chat/instruct models are called via the "conversational" route with
# the model's correct chat template, instead of a raw text-completion
# call that many hosted instruct models will reject.
_llm = HuggingFaceEndpoint(
    repo_id=HF_MODEL_REPO_ID,
    task="text-generation",
    max_new_tokens=3000,
    temperature=0.4,
    huggingfacehub_api_token=HF_TOKEN,
)
chat_model = ChatHuggingFace(llm=_llm)

app = FastAPI(title="Sankhya Setu Quiz Backend")

# During development, allow any origin. Before a real deployment,
# replace "*" with your actual site's domain(s).
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================
# Request / response schemas
# ============================================================
class GenerateQuizRequest(BaseModel):
    profile_id: str


class QuestionOut(BaseModel):
    id: str
    skill: str
    question: str
    options: list[str]


class GenerateQuizResponse(BaseModel):
    attempt_id: str
    questions: list[QuestionOut]


class AnswerIn(BaseModel):
    question_id: str
    selected_option: str


class SubmitQuizRequest(BaseModel):
    attempt_id: str
    answers: list[AnswerIn]


class SkillResult(BaseModel):
    skill: str
    score_percent: float
    required_level: Optional[float] = None


class SubmitQuizResponse(BaseModel):
    attempt_id: str
    overall_score_percent: float
    skills: list[SkillResult]
    current_skill_vector: dict[str, float]


# Schema the LLM's JSON output must match — used to validate before
# we trust anything it returns.


class QuizQuestionLLMOutput(BaseModel):
    skill: str
    question: str
    options: list[str] = Field(min_length=4, max_length=4)
    correct_option: str


class QuizLLMOutput(BaseModel):
    questions: list[QuizQuestionLLMOutput]


# ============================================================
# Supabase helpers
# ============================================================
def fetch_profile_context(profile_id: str) -> dict:
    """Pull the job-related details that personalize the quiz."""
    result = (
        supabase.table("profiles")
        .select("*, ministries(id, name), job_roles(id, name)")
        .eq("id", profile_id)
        .single()
        .execute()
    )
    profile = result.data
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")
    if not profile.get("job_roles"):
        raise HTTPException(status_code=400, detail="This profile has no job role selected yet")
    return profile


def fetch_role_skills(job_role_id: str) -> list[dict]:
    """The set of skills relevant to this role, along with the
    required_level already cached in job_role_skills — that value is
    generated once per role by seed_required_levels.py, not per quiz
    attempt, since it doesn't change per user."""
    result = (
        supabase.table("job_role_skills")
        .select("skill_id, required_level, skills(id, name)")
        .eq("job_role_id", job_role_id)
        .execute()
    )
    rows = result.data or []
    skills = [
        {"id": r["skills"]["id"], "name": r["skills"]["name"], "required_level": r["required_level"]}
        for r in rows if r.get("skills")
    ]
    if not skills:
        raise HTTPException(status_code=400, detail="No skills are configured for this job role yet")
    if any(s["required_level"] is None for s in skills):
        logger.warning(
            "Job role %s has skills with no required_level set yet — "
            "run seed_required_levels.py for this role.", job_role_id
        )
    return skills


# ============================================================
# LLM call helper — extracts + validates JSON, retries on failure.
# Open-source models are noticeably less reliable than GPT-4/Claude at
# strictly returning valid JSON, so this assumes failure is common and
# treats it as a normal case to recover from, not an edge case.
# ============================================================
def _extract_json_block(text: str) -> str:
    """Pull the first {...} or [...] block out of the model's raw
    output, in case it added markdown fences or explanation text
    around the JSON despite being told not to."""
    match = re.search(r"\{.*\}|\[.*\]", text, re.DOTALL)
    if not match:
        raise ValueError("No JSON object found in model output")
    return match.group(0)


def call_llm_for_json(system_prompt: str, user_prompt: str, validate_with) -> BaseModel:
    last_error = None
    for attempt in range(1, MAX_LLM_RETRIES + 1):
        prompt = user_prompt
        if attempt > 1:
            prompt += (
                "\n\nYour previous response could not be parsed as valid JSON. "
                "Respond with ONLY the JSON object. No markdown code fences, "
                "no explanation, no text before or after the JSON."
            )
        response = chat_model.invoke([
            SystemMessage(content=system_prompt),
            HumanMessage(content=prompt),
        ])
        raw_text = response.content
        try:
            json_block = _extract_json_block(raw_text)
            parsed = json.loads(json_block)
            return validate_with(**parsed)
        except (ValueError, json.JSONDecodeError, ValidationError) as e:
            last_error = e
            logger.warning("LLM JSON parse/validation failed on attempt %d: %s", attempt, e)
            continue
    raise HTTPException(
        status_code=502,
        detail=f"The model failed to return a usable quiz after {MAX_LLM_RETRIES} attempts: {last_error}",
    )


# ============================================================
# Prompt builders
# ============================================================
def build_quiz_prompt(profile: dict, skills: list[dict]) -> tuple[str, str]:
    skill_names = [s["name"] for s in skills]
    per_skill = max(1, QUESTIONS_PER_QUIZ // len(skill_names))
    system = (
        "You are an expert quiz writer for India's Official Statistics "
        "System training programs. You output ONLY valid JSON, nothing else."
    )
    user = f"""
Write exactly {QUESTIONS_PER_QUIZ} multiple-choice questions to assess a
government official's CURRENT proficiency in these skills: {", ".join(skill_names)}.

Context on who is taking this quiz:
Job role: {profile["job_roles"]["name"]}
Ministry / Department: {profile["ministries"]["name"] if profile.get("ministries") else "Not specified"}

Spread the questions across the listed skills as evenly as possible
(roughly {per_skill} questions per skill). Each question must have
exactly 4 answer options, with exactly one correct option. Vary
difficulty — include some foundational and some more advanced
questions per skill, since this quiz is meant to measure current
skill level, not just pass/fail.

Respond with ONLY a JSON object in exactly this shape:
{{
  "questions": [
    {{
      "skill": "Exact skill name from the list above",
      "question": "The question text",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "correct_option": "The exact text of the correct option, matching one of the options above"
    }}
  ]
}}
""".strip()
    return system, user


# ============================================================
# Endpoints
# ============================================================
@app.post("/generate-quiz", response_model=GenerateQuizResponse)
def generate_quiz(req: GenerateQuizRequest):
    profile = fetch_profile_context(req.profile_id)
    skills = fetch_role_skills(profile["job_roles"]["id"])
    skill_name_to_id = {s["name"]: s["id"] for s in skills}

    # --- quiz questions ---
    # (the required skill vector isn't generated here — it's generated
    # once per job role by seed_required_levels.py and cached in
    # job_role_skills.required_level, since it doesn't vary per user)
    q_system, q_user = build_quiz_prompt(profile, skills)
    quiz: QuizLLMOutput = call_llm_for_json(q_system, q_user, QuizLLMOutput)

    # Drop any question whose skill or answer doesn't actually match
    # what we asked for, rather than trusting the model completely.
    valid_questions = [
        q for q in quiz.questions
        if q.skill in skill_name_to_id and q.correct_option in q.options
    ]
    if not valid_questions:
        raise HTTPException(status_code=502, detail="The model didn't return any usable questions")

    # --- persist the attempt ---
    attempt = (
        supabase.table("quiz_attempts")
        .insert({
            "profile_id": req.profile_id,
            "ministry_id": profile.get("ministry_id"),
            "job_role_id": profile["job_roles"]["id"],
            "source": "initial",
        })
        .execute()
    )
    attempt_id = attempt.data[0]["id"]

    question_rows = [
        {
            "attempt_id": attempt_id,
            "skill_id": skill_name_to_id[q.skill],
            "question_text": q.question,
            "options": q.options,
            "correct_option": q.correct_option,
        }
        for q in valid_questions
    ]
    inserted = supabase.table("quiz_attempt_questions").insert(question_rows).execute()

    # Return questions WITHOUT correct_option — the client shouldn't
    # receive the answer key before submitting.
    questions_out = [
        QuestionOut(
            id=row["id"],
            skill=next(q.skill for q in valid_questions if q.question == row["question_text"]),
            question=row["question_text"],
            options=row["options"],
        )
        for row in inserted.data
    ]

    return GenerateQuizResponse(attempt_id=attempt_id, questions=questions_out)


@app.post("/submit-quiz", response_model=SubmitQuizResponse)
def submit_quiz(req: SubmitQuizRequest):
    attempt = (
        supabase.table("quiz_attempts")
        .select("*")
        .eq("id", req.attempt_id)
        .single()
        .execute()
    )
    if not attempt.data:
        raise HTTPException(status_code=404, detail="Quiz attempt not found")

    questions = (
        supabase.table("quiz_attempt_questions")
        .select("*, skills(id, name)")
        .eq("attempt_id", req.attempt_id)
        .execute()
    ).data

    answers_by_question = {a.question_id: a.selected_option for a in req.answers}

    # Score each question and update it in place.
    per_skill_correct: dict[str, int] = {}
    per_skill_total: dict[str, int] = {}
    skill_id_to_name = {}

    for q in questions:
        selected = answers_by_question.get(q["id"])
        is_correct = selected is not None and selected == q["correct_option"]
        supabase.table("quiz_attempt_questions").update({
            "selected_option": selected,
            "is_correct": is_correct,
        }).eq("id", q["id"]).execute()

        skill_id = q["skill_id"]
        skill_name = q["skills"]["name"] if q.get("skills") else "Unknown"
        skill_id_to_name[skill_id] = skill_name
        per_skill_total[skill_id] = per_skill_total.get(skill_id, 0) + 1
        if is_correct:
            per_skill_correct[skill_id] = per_skill_correct.get(skill_id, 0) + 1

    # required_level lives on job_role_skills (generated once per role
    # by seed_required_levels.py), not on the attempt itself.
    role_skills = (
        supabase.table("job_role_skills")
        .select("skill_id, required_level")
        .eq("job_role_id", attempt.data["job_role_id"])
        .execute()
    ).data or []
    required_by_skill_id = {r["skill_id"]: r["required_level"] for r in role_skills}

    results = []
    snapshot_rows = []
    current_skill_vector = {}
    for skill_id, total in per_skill_total.items():
        correct = per_skill_correct.get(skill_id, 0)
        score_percent = round((correct / total) * 100, 1)
        skill_name = skill_id_to_name[skill_id]
        # score_percent is 0-100; convert to the same 0-10 scale used
        # for required_level so the two are directly comparable.
        # skill_snapshots.score is an INT column, so this must be a
        # whole number — score_percent/10 (e.g. 8.5) would otherwise
        # get sent as "8.5" and rejected by Postgres.
        score_0_to_10_precise = round(score_percent / 10, 1)
        score_0_to_10_int = round(score_percent / 10)
        current_skill_vector[skill_name] = score_0_to_10_precise

        results.append(SkillResult(
            skill=skill_name,
            score_percent=score_percent,
            required_level=required_by_skill_id.get(skill_id),
        ))
        snapshot_rows.append({
            "profile_id": attempt.data["profile_id"],
            "attempt_id": req.attempt_id,
            "skill_id": skill_id,
            "score": score_0_to_10_int,
            "source": attempt.data.get("source", "initial"),
        })

    if snapshot_rows:
        supabase.table("skill_snapshots").insert(snapshot_rows).execute()

    overall = round(sum(r.score_percent for r in results) / len(results), 1) if results else 0.0

    return SubmitQuizResponse(
        attempt_id=req.attempt_id,
        overall_score_percent=overall,
        skills=results,
        current_skill_vector=current_skill_vector,
    )


@app.get("/health")
def health():
    return {"status": "ok", "model": HF_MODEL_REPO_ID}
