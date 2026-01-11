"""FastAPI application entry point.

Issue: tauri-explorer-p1f
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .routes import files

app = FastAPI(title="Explorer API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Tauri webview
    allow_methods=["GET"],
    allow_headers=["*"],
)

app.include_router(files.router, prefix="/api/files", tags=["files"])


@app.get("/health")
def health():
    """Health check endpoint."""
    return {"status": "ok"}
