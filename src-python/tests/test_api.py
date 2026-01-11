"""Tests for FastAPI endpoints.

Issue: tauri-explorer-p1f
"""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from api.main import app

client = TestClient(app)


class TestHealth:
    """Tests for /health endpoint."""

    def test_health_returns_ok(self):
        response = client.get("/health")
        assert response.status_code == 200
        assert response.json() == {"status": "ok"}


class TestListFiles:
    """Tests for /api/files/list endpoint."""

    def test_list_files_valid_path(self, tmp_path: Path):
        (tmp_path / "test.txt").write_text("content")

        response = client.get(f"/api/files/list?path={tmp_path}")

        assert response.status_code == 200
        data = response.json()
        assert data["path"] == str(tmp_path)
        assert len(data["entries"]) == 1
        assert data["entries"][0]["name"] == "test.txt"

    def test_list_files_empty_directory(self, tmp_path: Path):
        response = client.get(f"/api/files/list?path={tmp_path}")

        assert response.status_code == 200
        data = response.json()
        assert data["entries"] == []

    def test_list_files_not_found(self):
        response = client.get("/api/files/list?path=/nonexistent/path/12345")

        assert response.status_code == 404
        assert "not found" in response.json()["detail"].lower()

    def test_list_files_missing_param(self):
        response = client.get("/api/files/list")

        assert response.status_code == 422

    def test_list_files_returns_correct_structure(self, tmp_path: Path):
        (tmp_path / "file.txt").write_text("content")
        (tmp_path / "subdir").mkdir()

        response = client.get(f"/api/files/list?path={tmp_path}")

        data = response.json()
        assert "path" in data
        assert "entries" in data

        # Check entry structure
        for entry in data["entries"]:
            assert "name" in entry
            assert "path" in entry
            assert "kind" in entry
            assert "size" in entry
            assert "modified" in entry

    def test_list_files_directories_first(self, tmp_path: Path):
        (tmp_path / "z_file.txt").touch()
        (tmp_path / "a_dir").mkdir()

        response = client.get(f"/api/files/list?path={tmp_path}")

        entries = response.json()["entries"]
        assert entries[0]["kind"] == "directory"
        assert entries[1]["kind"] == "file"
