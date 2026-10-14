import { useEffect, useState } from "react";

// Tiny path router: the server serves index.html for every non-API path.
export function navigate(to) {
  if (to !== window.location.pathname) window.history.pushState({}, "", to);
  window.dispatchEvent(new Event("panel:navigate"));
}

export function usePath() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const update = () => setPath(window.location.pathname);
    window.addEventListener("popstate", update);
    window.addEventListener("panel:navigate", update);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener("panel:navigate", update);
    };
  }, []);
  return path;
}
