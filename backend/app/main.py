import re
import shutil
import uuid
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse

from .analysis import analyze_file

BASE = Path(__file__).resolve().parent.parent
UPLOADS = BASE / "uploads"
OUTPUTS = BASE / "outputs"
UPLOADS.mkdir(exist_ok=True)
OUTPUTS.mkdir(exist_ok=True)

app = FastAPI(title="Engenharia Musical")


@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/audio/{job}")
def audio(job: str):
    if not re.fullmatch(r"[0-9a-f]{32}", job):
        raise HTTPException(status_code=404)
    found = next(UPLOADS.glob(f"{job}.*"), None)
    if not found:
        raise HTTPException(status_code=404)
    return FileResponse(found)


@app.post("/api/analyze")
def analyze(file: UploadFile = File(...)):
    suffix = Path(file.filename or "audio").suffix.lower()
    if suffix not in {".mp3", ".wav", ".flac", ".ogg", ".m4a"}:
        raise HTTPException(status_code=400, detail="Formato não suportado. Use mp3, wav, flac, ogg ou m4a.")

    job = uuid.uuid4().hex
    dest = UPLOADS / f"{job}{suffix}"
    with dest.open("wb") as out:
        shutil.copyfileobj(file.file, out)

    try:
        result = analyze_file(dest, OUTPUTS / job)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Falha na análise: {exc}") from exc

    result["audio_url"] = f"/api/audio/{job}"
    result["name"] = Path(file.filename or "música").stem
    return result
