"""The profile-photo true-replace logic in TelethonClient (client feedback 2026-10-21).

Telegram keeps a photo history, so "Change photo" must wipe it first, then upload, then verify the
account is left with exactly one photo (zero for Remove). We drive the real client methods against a
fake low-level Telethon so no network is needed.
"""

import asyncio

import pytest

from panel.tg.client import TelethonClient, TgError


class FakePhoto:
    def __init__(self, pid: int):
        self.id = pid
        self.access_hash = pid * 10
        self.file_reference = b"ref"


class FakeLowLevel:
    """Stands in for TelegramClient: tracks the profile-photo list and the requests it receives."""

    def __init__(self, photos, *, delete_works=True):
        self._photos = list(photos)
        self.delete_works = delete_works
        self.calls: list[str] = []
        self.deleted_counts: list[int] = []

    async def get_profile_photos(self, who, limit=200):
        return list(self._photos)

    async def upload_file(self, path):
        return ("uploaded", path)

    async def __call__(self, req):
        name = type(req).__name__
        self.calls.append(name)
        if name == "DeletePhotosRequest":
            self.deleted_counts.append(len(req.id))
            if self.delete_works:
                self._photos = []
        elif name == "UploadProfilePhotoRequest":
            self._photos.append(FakePhoto(999))
        return None


def make_client(low) -> TelethonClient:
    c = TelethonClient.__new__(TelethonClient)  # skip __init__: no real TelegramClient / session needed
    c._c = low
    return c


def test_change_photo_replaces_the_whole_history():
    low = FakeLowLevel([FakePhoto(1), FakePhoto(2), FakePhoto(3)])
    make_client(low)  # sanity: keep the ref
    asyncio.run(make_client(low).set_profile_photo("/tmp/new.jpg"))
    assert len(low._photos) == 1  # exactly one left — the new photo
    assert low.calls == ["DeletePhotosRequest", "UploadProfilePhotoRequest"]  # delete before upload
    assert low.deleted_counts == [3]  # all three old photos were deleted


def test_change_photo_with_no_prior_history_just_uploads():
    low = FakeLowLevel([])
    asyncio.run(make_client(low).set_profile_photo("/tmp/new.jpg"))
    assert len(low._photos) == 1
    assert low.calls == ["UploadProfilePhotoRequest"]  # nothing to delete


def test_change_photo_raises_if_history_isnt_cleared():
    # Telegram didn't actually drop the old photos: end state has >1, so we surface an error.
    low = FakeLowLevel([FakePhoto(1), FakePhoto(2)], delete_works=False)
    with pytest.raises(TgError) as e:
        asyncio.run(make_client(low).set_profile_photo("/tmp/new.jpg"))
    assert e.value.status == "photo_failed"


def test_remove_photo_deletes_all_and_verifies_zero():
    low = FakeLowLevel([FakePhoto(1), FakePhoto(2)])
    asyncio.run(make_client(low).delete_profile_photo())
    assert low._photos == []
    assert low.deleted_counts == [2]


def test_remove_photo_raises_if_any_remain():
    low = FakeLowLevel([FakePhoto(1)], delete_works=False)
    with pytest.raises(TgError) as e:
        asyncio.run(make_client(low).delete_profile_photo())
    assert e.value.status == "photo_failed"
