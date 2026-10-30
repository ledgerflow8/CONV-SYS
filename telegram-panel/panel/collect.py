"""Turns uploaded files (.session, .json, .zip) into import candidates, entirely in memory.

Zips are read entry by entry with size limits; nothing is extracted to disk, so paths inside
the zip can't escape anywhere.
"""

import hashlib
import io
import json
import zipfile
from dataclasses import dataclass, field
from pathlib import PurePosixPath
from typing import Any

MAX_ENTRIES = 1000
MAX_ENTRY_BYTES = 20 * 1024 * 1024
MAX_TOTAL_BYTES = 200 * 1024 * 1024


@dataclass
class Candidate:
    name: str  # what the client sees in the results, e.g. "batch/123.session"
    session: bytes
    meta: dict[str, Any] | None = None
    meta_error: str | None = None


@dataclass
class Collected:
    candidates: list[Candidate] = field(default_factory=list)
    invalid: list[tuple[str, str]] = field(default_factory=list)  # (name, reason)


class TooLarge(ValueError):
    pass


def _skip(path: str) -> bool:
    parts = PurePosixPath(path).parts
    return any(p.startswith(".") or p == "__MACOSX" for p in parts)


def _entries(filename: str, data: bytes, budget: list[int]) -> list[tuple[str, bytes]]:
    """(path, bytes) of every file in the upload; zips are expanded one level."""
    if not filename.lower().endswith(".zip"):
        return [(filename, data)]
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise ValueError(f"{filename}: not a valid zip") from None
    infos = [i for i in zf.infolist() if not i.is_dir() and not _skip(i.filename)]
    if len(infos) > MAX_ENTRIES:
        raise TooLarge(f"{filename}: more than {MAX_ENTRIES} files")
    out = []
    for info in infos:
        if info.file_size > MAX_ENTRY_BYTES:
            raise TooLarge(f"{filename}: {info.filename} is too large")
        budget[0] -= info.file_size
        if budget[0] < 0:
            raise TooLarge("the upload unpacks to more than 200 MB")
        with zf.open(info) as f:
            content = f.read(MAX_ENTRY_BYTES + 1)  # declared sizes can lie
        if len(content) > MAX_ENTRY_BYTES:
            raise TooLarge(f"{filename}: {info.filename} is too large")
        out.append((f"{PurePosixPath(filename).stem}/{info.filename}", content))
    return out


def collect(files: list[tuple[str, bytes]]) -> Collected:
    """Find every `.session` in the upload (walking each zip recursively, at any depth) and pair it
    with its `.json`:

      1. a `.json` with the same name in the same folder — the common per-account layout
         (`telegram-accounts-xxxx/<phone>/<phone>.session` + `<phone>.json`); else
      2. a `.json` with the same basename anywhere — the `all_sessions/` + `all_json/` layout.

    The same account appearing twice (identical session bytes) is collapsed. `__MACOSX`/dotfiles are
    ignored. A `.json` that never pairs is reported invalid. Raises TooLarge / ValueError for a bad upload.
    """
    budget = [MAX_TOTAL_BYTES]
    result = Collected()
    sessions: list[tuple[str, bytes]] = []
    metas: list[tuple[str, bytes]] = []  # (path, content), in upload order

    for filename, data in files:
        name = PurePosixPath(filename.replace("\\", "/")).name or "upload"
        try:
            entries = _entries(name, data, budget)
        except TooLarge:
            raise
        except ValueError as e:
            result.invalid.append((name, str(e).split(": ", 1)[-1]))
            continue
        for path, content in entries:
            if _skip(path):
                continue  # __MACOSX / .DS_Store / any dotfile, at any depth
            ext = PurePosixPath(path).suffix.lower()
            if ext == ".session":
                sessions.append((path, content))
            elif ext == ".json":
                metas.append((path, content))
            elif ext == ".zip":
                result.invalid.append((path, "zips inside zips aren't supported"))
            # anything else (readme.txt, tdata files…) is ignored

    # Index the .json files for pairing, and remember which ones get used.
    by_dirstem: dict[tuple[str, str], int] = {}
    by_stem: dict[str, list[int]] = {}
    for i, (path, _content) in enumerate(metas):
        p = PurePosixPath(path)
        by_dirstem[(str(p.parent).lower(), p.stem.lower())] = i
        by_stem.setdefault(p.stem.lower(), []).append(i)
    consumed: set[int] = set()

    seen_sessions: set[str] = set()
    for path, content in sessions:
        digest = hashlib.sha256(content).hexdigest()
        if digest in seen_sessions:
            continue  # the same account's session appears more than once in the upload
        seen_sessions.add(digest)
        p = PurePosixPath(path)
        idx = by_dirstem.get((str(p.parent).lower(), p.stem.lower()))
        if idx is None:
            same = by_stem.get(p.stem.lower())
            idx = same[0] if same and len(same) == 1 else None
        c = Candidate(name=path, session=content)
        if idx is not None:
            consumed.add(idx)
            try:
                c.meta = json.loads(metas[idx][1].decode("utf-8-sig"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                c.meta_error = "the .json next to it isn't valid JSON"
        result.candidates.append(c)

    for i, (path, _content) in enumerate(metas):
        if i not in consumed:
            result.invalid.append((path, "no .session file with the same name"))
    return result
