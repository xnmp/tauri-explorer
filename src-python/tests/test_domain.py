"""Tests for domain layer - file entry operations."""

from pathlib import Path
import pytest
from domain.file_entry import FileEntry, list_directory
from domain.file_ops import create_directory, rename_entry, delete_entry, copy_entry, move_entry


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


class TestCreateDirectory:
    """Tests for create_directory function.

    Issue: tauri-explorer-jql
    """

    def test_create_directory_success(self, tmp_path: Path):
        new_dir = tmp_path / "new_folder"

        result = create_directory(new_dir)

        assert new_dir.exists()
        assert new_dir.is_dir()
        assert result["name"] == "new_folder"
        assert result["kind"] == "directory"

    def test_create_directory_returns_entry(self, tmp_path: Path):
        new_dir = tmp_path / "test_dir"

        result = create_directory(new_dir)

        assert "name" in result
        assert "path" in result
        assert "kind" in result
        assert "size" in result
        assert "modified" in result

    def test_create_directory_already_exists(self, tmp_path: Path):
        existing = tmp_path / "existing"
        existing.mkdir()

        with pytest.raises(FileExistsError):
            create_directory(existing)

    def test_create_directory_parent_not_exists(self, tmp_path: Path):
        nested = tmp_path / "nonexistent" / "new_folder"

        with pytest.raises(FileNotFoundError):
            create_directory(nested)

    def test_create_directory_invalid_chars(self, tmp_path: Path):
        # Null byte in name (invalid on all platforms)
        with pytest.raises((ValueError, OSError)):
            create_directory(tmp_path / "invalid\x00name")


class TestRenameEntry:
    """Tests for rename_entry function.

    Issue: tauri-explorer-bae
    """

    def test_rename_file_success(self, tmp_path: Path):
        old_file = tmp_path / "old.txt"
        old_file.write_text("content")

        result = rename_entry(old_file, "new.txt")

        assert not old_file.exists()
        assert (tmp_path / "new.txt").exists()
        assert result["name"] == "new.txt"

    def test_rename_directory_success(self, tmp_path: Path):
        old_dir = tmp_path / "old_dir"
        old_dir.mkdir()

        result = rename_entry(old_dir, "new_dir")

        assert not old_dir.exists()
        assert (tmp_path / "new_dir").exists()
        assert result["kind"] == "directory"

    def test_rename_preserves_content(self, tmp_path: Path):
        old_file = tmp_path / "old.txt"
        old_file.write_text("original content")

        rename_entry(old_file, "new.txt")

        assert (tmp_path / "new.txt").read_text() == "original content"

    def test_rename_target_exists(self, tmp_path: Path):
        (tmp_path / "existing.txt").touch()
        source = tmp_path / "source.txt"
        source.touch()

        with pytest.raises(FileExistsError):
            rename_entry(source, "existing.txt")

    def test_rename_source_not_exists(self, tmp_path: Path):
        with pytest.raises(FileNotFoundError):
            rename_entry(tmp_path / "nonexistent.txt", "new.txt")

    def test_rename_empty_name(self, tmp_path: Path):
        source = tmp_path / "file.txt"
        source.touch()

        with pytest.raises(ValueError):
            rename_entry(source, "")


class TestDeleteEntry:
    """Tests for delete_entry function.

    Issue: tauri-explorer-h3n
    """

    def test_delete_file_success(self, tmp_path: Path):
        file = tmp_path / "file.txt"
        file.write_text("content")

        delete_entry(file)

        assert not file.exists()

    def test_delete_empty_directory(self, tmp_path: Path):
        dir = tmp_path / "empty_dir"
        dir.mkdir()

        delete_entry(dir)

        assert not dir.exists()

    def test_delete_directory_with_contents(self, tmp_path: Path):
        dir = tmp_path / "dir_with_files"
        dir.mkdir()
        (dir / "file1.txt").write_text("content1")
        (dir / "subdir").mkdir()
        (dir / "subdir" / "file2.txt").write_text("content2")

        delete_entry(dir)

        assert not dir.exists()

    def test_delete_nonexistent_raises(self, tmp_path: Path):
        with pytest.raises(FileNotFoundError):
            delete_entry(tmp_path / "nonexistent.txt")


class TestCopyEntry:
    """Tests for copy_entry function.

    Issue: tauri-explorer-x25
    """

    def test_copy_file_success(self, tmp_path: Path):
        source = tmp_path / "source.txt"
        source.write_text("content")
        dest_dir = tmp_path / "dest"
        dest_dir.mkdir()

        result = copy_entry(source, dest_dir)

        assert source.exists()  # Source should still exist
        assert (dest_dir / "source.txt").exists()
        assert (dest_dir / "source.txt").read_text() == "content"
        assert result["name"] == "source.txt"

    def test_copy_directory_success(self, tmp_path: Path):
        source = tmp_path / "source_dir"
        source.mkdir()
        (source / "file.txt").write_text("content")
        dest_dir = tmp_path / "dest"
        dest_dir.mkdir()

        result = copy_entry(source, dest_dir)

        assert source.exists()
        assert (dest_dir / "source_dir").exists()
        assert (dest_dir / "source_dir" / "file.txt").read_text() == "content"
        assert result["kind"] == "directory"

    def test_copy_source_not_found(self, tmp_path: Path):
        dest_dir = tmp_path / "dest"
        dest_dir.mkdir()

        with pytest.raises(FileNotFoundError):
            copy_entry(tmp_path / "nonexistent.txt", dest_dir)

    def test_copy_dest_not_found(self, tmp_path: Path):
        source = tmp_path / "source.txt"
        source.write_text("content")

        with pytest.raises(FileNotFoundError):
            copy_entry(source, tmp_path / "nonexistent")

    def test_copy_target_exists(self, tmp_path: Path):
        source = tmp_path / "source.txt"
        source.write_text("content")
        dest_dir = tmp_path / "dest"
        dest_dir.mkdir()
        (dest_dir / "source.txt").write_text("existing")

        with pytest.raises(FileExistsError):
            copy_entry(source, dest_dir)


class TestMoveEntry:
    """Tests for move_entry function.

    Issue: tauri-explorer-x25
    """

    def test_move_file_success(self, tmp_path: Path):
        source = tmp_path / "source.txt"
        source.write_text("content")
        dest_dir = tmp_path / "dest"
        dest_dir.mkdir()

        result = move_entry(source, dest_dir)

        assert not source.exists()  # Source should be gone
        assert (dest_dir / "source.txt").exists()
        assert (dest_dir / "source.txt").read_text() == "content"
        assert result["name"] == "source.txt"

    def test_move_directory_success(self, tmp_path: Path):
        source = tmp_path / "source_dir"
        source.mkdir()
        (source / "file.txt").write_text("content")
        dest_dir = tmp_path / "dest"
        dest_dir.mkdir()

        result = move_entry(source, dest_dir)

        assert not source.exists()
        assert (dest_dir / "source_dir").exists()
        assert (dest_dir / "source_dir" / "file.txt").read_text() == "content"
        assert result["kind"] == "directory"

    def test_move_source_not_found(self, tmp_path: Path):
        dest_dir = tmp_path / "dest"
        dest_dir.mkdir()

        with pytest.raises(FileNotFoundError):
            move_entry(tmp_path / "nonexistent.txt", dest_dir)

    def test_move_dest_not_found(self, tmp_path: Path):
        source = tmp_path / "source.txt"
        source.write_text("content")

        with pytest.raises(FileNotFoundError):
            move_entry(source, tmp_path / "nonexistent")

    def test_move_target_exists(self, tmp_path: Path):
        source = tmp_path / "source.txt"
        source.write_text("content")
        dest_dir = tmp_path / "dest"
        dest_dir.mkdir()
        (dest_dir / "source.txt").write_text("existing")

        with pytest.raises(FileExistsError):
            move_entry(source, dest_dir)
