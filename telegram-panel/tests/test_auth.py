from panel.auth import LoginLimiter
from tests.conftest import PASSWORD, H, login, set_password


def test_me_requires_login(client):
    assert client.get("/api/auth/me").status_code == 401


def test_login_without_password_set_explains_how(client):
    r = login(client)
    assert r.status_code == 503
    assert "set-password" in r.json()["detail"]


def test_login_flow_and_cookie_flags(client):
    set_password(client)
    assert login(client, "wrong password!").status_code == 401

    r = login(client)
    assert r.status_code == 200
    cookie = r.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=strict" in cookie and "secure" in cookie
    assert client.get("/api/auth/me").status_code == 200

    assert client.post("/api/auth/logout", headers=H).status_code == 200
    assert client.get("/api/auth/me").status_code == 401


def test_password_change_ends_existing_sessions(client):
    set_password(client)
    login(client)
    assert client.get("/api/auth/me").status_code == 200
    set_password(client, "another long password")
    assert client.get("/api/auth/me").status_code == 401


def test_forged_cookie_rejected(client):
    set_password(client)
    client.cookies.set("tgpanel_session", "1.forged.sig", domain="panel.example.com")
    assert client.get("/api/auth/me").status_code == 401


def test_mutations_need_x_panel_header(client):
    set_password(client)
    r = client.post("/api/auth/login", json={"password": PASSWORD})
    assert r.status_code == 403


def test_rate_limit_blocks_even_the_right_password(client):
    set_password(client)
    for _ in range(5):
        assert login(client, "nope nope nope").status_code == 401
    assert login(client).status_code == 429


def test_limiter_window_and_global_cap():
    lim = LoginLimiter(per_ip=2, total=3, window_sec=100)
    lim.fail("a", now=0)
    lim.fail("a", now=1)
    assert lim.retry_after("a", now=2) == 98
    assert lim.retry_after("a", now=101) == 0  # first failure aged out

    lim = LoginLimiter(per_ip=2, total=3, window_sec=100)
    for ip in ("b", "c", "d"):
        lim.fail(ip, now=0)
    assert lim.retry_after("e", now=1) == 99  # global cap reached by other IPs
