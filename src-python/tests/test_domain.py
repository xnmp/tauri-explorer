"""Tests for domain layer - file entry operations."""

from pathlib import Path
import pytest
from domain.file_entry import FileEntry, list_directory


class TestFileEntry:
    """Tests for FileEntry dataclass."""

    def test_file_entry_creation(self):
        entry = FileEntry(
            name="test.txt",
            path="/home/user/test.txt",
            kind="file",
            size=1024,
            modified="2025-01-01T00:00:00",
        )
        assert entry.name == "test.txt"
        assert entry.kind == "file"
        assert entry.size == 1024

    def test_file_entry_is_immutable(self):
        entry = FileEntry(
            name="test.txt",
            path="/test.txt",
            kind="file",
            size=100,
            modified="2025-01-01T00:00:00",
        )
        with pytest.raises(AttributeError):
            entry.name = "changed"


class TestListDirectory:
    """Tests for list_directory function."""

    def test_list_empty_directory(self, tmp_path: Path):
        entries = list_directory(tmp_path)
        assert entries == []

    def test_list_directory_with_files(self, tmp_path: Path):
        (tmp_path / "file.txt").write_text("content")

        entries = list_directory(tmp_path)

        assert len(entries) == 1
        assert entries[0]["name"] == "file.txt"
        assert entries[0]["kind"] == "file"
        assert entries[0]["size"] > 0

    def test_list_directory_with_subdirectory(self, tmp_path: Path):
        (tmp_path / "subdir").mkdir()

        entries = list_directory(tmp_path)

        assert len(entries) == 1
        assert entries[0]["name"] == "subdir"
        assert entries[0]["kind"] == "directory"
        assert entries[0]["size"] == 0

    def test_directories_sorted_before_files(self, tmp_path: Path):
        (tmp_path / "z_file.txt").touch()
        (tmp_path / "a_file.txt").touch()
        (tmp_path / "m_subdir").mkdir()

        entries = list_directory(tmp_path)

        assert entries[0]["name"] == "m_subdir"
        assert entries[0]["kind"] == "directory"
        assert entries[1]["name"] == "a_file.txt"
        assert entries[2]["name"] == "z_file.txt"

    def test_files_sorted_case_insensitively(self, tmp_path: Path):
        (tmp_path / "Zebra.txt").touch()
        (tmp_path / "alpha.txt").touch()
        (tmp_path / "Beta.txt").touch()

        entries = list_directory(tmp_path)

        names = [e["name"] for e in entries]
        assert names == ["alpha.txt", "Beta.txt", "Zebra.txt"]

    def test_nonexistent_directory_raises(self):
        with pytest.raises(FileNotFoundError):
            list_directory(Path("/nonexistent/path/12345"))

    def test_file_path_raises(self, tmp_path: Path):
        file_path = tmp_path / "file.txt"
        file_path.touch()

        with pytest.raises(FileNotFoundError):
            list_directory(file_path)

    def test_entries_contain_absolute_paths(self, tmp_path: Path):
        (tmp_path / "test.txt").touch()

        entries = list_directory(tmp_path)

        assert Path(entries[0]["path"]).is_absolute()

    def test_modified_is_iso_format(self, tmp_path: Path):
        (tmp_path / "test.txt").touch()

        entries = list_directory(tmp_path)

        # ISO format: YYYY-MM-DDTHH:MM:SS
        modified = entries[0]["modified"]
        assert "T" in modified
        assert len(modified) >= 19
