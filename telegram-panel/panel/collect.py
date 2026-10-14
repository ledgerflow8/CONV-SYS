"""Turns uploaded files (.session, .json, .zip) into import candidates, entirely in memory.

Zips are read entry by entry with size limits; nothing is extracted to disk, so paths inside
the zip can't escape anywhere.
"""

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
    """Pairs `x.session` with `x.json` from the same folder. Raises TooLarge / ValueError for a bad upload."""
    budget = [MAX_TOTAL_BYTES]
    sessions: dict[str, tuple[str, bytes]] = {}
    metas: dict[str, tuple[str, bytes]] = {}
    result = Collected()

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
            p = PurePosixPath(path)
            key = str(p.with_suffix("")).lower()
            ext = p.suffix.lower()
            if ext == ".session":
                sessions[key] = (path, content)
            elif ext == ".json":
                metas[key] = (path, content)
            elif ext == ".zip":
                result.invalid.append((path, "zips inside zips aren't supported"))
            # anything else (readme.txt, tdata files…) is ignored

    for key, (path, content) in sessions.items():
        c = Candidate(name=path, session=content)
        if key in metas:
            raw = metas.pop(key)[1]
            try:
                c.meta = json.loads(raw.decode("utf-8-sig"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                c.meta_error = "the .json next to it isn't valid JSON"
        result.candidates.append(c)
    for path, _ in metas.values():
        result.invalid.append((path, "no .session file with the same name"))
    return result
