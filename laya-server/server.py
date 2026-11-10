# Laya sidecar for Browser Use — local System One decision server.
#
# Serves the ENGLISH checkpoint only (ModernBERT-large, 421M params) so weak-
# machine and disk footprints stay small. All answers are calibrated
# probabilities from one forward pass (~33ms on GPU, 200-460ms on CPU).
#
# Weights: the Browser-use app downloads the checkpoint ITSELF (with real
# byte progress shown in the settings dialogue) into the cache dir passed via
# LAYA_MODEL_PATH, then starts this server against the local copy. If
# LAYA_MODEL_PATH is not set, the Agent falls back to the HuggingFace hub id.
#
# The HTTP server binds immediately and the model loads in a background
# thread, so /health can report the load stage (loading/ready/error) while
# the weights are being read from disk.
#
# Manual setup (equivalent):
#   pip install laya fastapi "uvicorn[standard]"
#   python server.py            # listens on 127.0.0.1:8765
#
# Endpoints:
#   GET  /health  -> {"ok": bool, "status": "loading"|"ready"|"error",
#                     "detail": str, "device": "cpu"|"cuda"|null}
#   POST /predict {"state": {...}, "questions": {...}} -> {"answers": {...}}

import os
import threading
import time
from typing import Any, Dict

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from laya import Router, load

MODEL_SOURCE = os.environ.get("LAYA_MODEL_PATH", "convaiinnovations/laya")

app = FastAPI(title="Browser-use Laya sidecar")
router = Router()
state: Dict[str, Any] = {"status": "loading", "detail": "", "device": None}


def _load_model() -> None:
    try:
        agent = load(MODEL_SOURCE)
        router.attach("english", agent)
        state["device"] = str(agent.device)
        state["status"] = "ready"
        state["detail"] = ""
    except Exception as error:  # noqa: BLE001 - surfaced verbatim via /health
        state["status"] = "error"
        state["detail"] = str(error)[:500]


threading.Thread(target=_load_model, daemon=True).start()


class PredictRequest(BaseModel):
    state: Dict[str, Any]
    questions: Dict[str, Any]


@app.get("/health")
def health():
    return {
        "ok": state["status"] == "ready",
        "status": state["status"],
        "detail": state["detail"],
        "device": state["device"],
    }


@app.post("/predict")
def predict(request: PredictRequest):
    if state["status"] != "ready":
        return JSONResponse(
            {"error": f"model not ready ({state['status']}): {state['detail']}"}, status_code=503
        )
    started = time.perf_counter()
    result = router.predict(request.state, request.questions, model="english")
    answers = {}
    for name, answer in (result.get("answers") or {}).items():
        answers[name] = {
            "noul": answer.get("noul"),
            "choice": answer.get("choice"),
            "score": answer.get("score"),
            "confidence": answer.get("confidence"),
            "probabilities": answer.get("probabilities"),
        }
    return {
        "answers": answers,
        "tookMs": round((time.perf_counter() - started) * 1000, 1),
        "routing": result.get("routing"),
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="warning")
