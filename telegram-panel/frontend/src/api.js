// Every call to the panel API goes through here. Mutations carry X-Panel: 1 (the server's CSRF check).

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

export async function api(path, { method = "GET", body } = {}) {
  const headers = { "X-Panel": "1" };
  if (body !== undefined && !(body instanceof FormData)) headers["Content-Type"] = "application/json";
  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: "same-origin",
      body: body === undefined || body instanceof FormData ? body : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "Can't reach the panel. Check your connection.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && path !== "/api/auth/login") onUnauthorized();
    throw new ApiError(res.status, typeof data.detail === "string" ? data.detail : `Request failed (${res.status})`);
  }
  return data;
}
