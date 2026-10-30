"""Our own Tier-1 country filter (PLAN.md §10), so we don't pay Capitalbot to filter non-Tier-1 fans.

When a fan's phone is visible we resolve its country (libphonenumber, via `phonenumbers`) and, if it
isn't Tier 1, skip the AI call — the portal still rejects the convo as non_tier1 from the phone it
already received. When the phone is hidden a setting decides: let the AI's own tier check run
(default), or don't reply at all.

`phonenumbers` is imported lazily and optionally: without it, country can't be resolved, so visible
phones fall back to the hidden-phone rule rather than being wrongly blocked.
"""

try:
    import phonenumbers
except Exception:  # pragma: no cover - import guard
    phonenumbers = None

# Mirrors the portal's default Tier-1 list (src/lib/settings-defaults.ts). The owner can edit it.
DEFAULT_TIER1 = ["US", "CA", "GB", "AU", "NZ", "IE", "GG", "JE", "IM", "DE", "NO", "FI", "FR"]

# Gate decisions.
ALLOW = "allow"  # call Capitalbot as usual
REJECT_NON_TIER1 = "reject_non_tier1"  # visible non-Tier-1 phone: skip AI (portal rejects from the phone)
SKIP = "skip"  # hidden phone, owner chose "don't reply": skip AI, report nothing


def country_for_phone(phone: str | None) -> str | None:
    """ISO-2 country for an E.164 phone, or None if absent/unresolvable/library missing."""
    if not phone or phonenumbers is None:
        return None
    try:
        num = phonenumbers.parse(phone if phone.strip().startswith("+") else "+" + phone.strip(), None)
        if not phonenumbers.is_possible_number(num):
            return None
        return phonenumbers.region_code_for_number(num)
    except Exception:
        return None


def tier_decision(country: str | None, *, enabled: bool, hidden_mode: str, tier1: list[str]) -> str:
    """country is the resolved ISO-2 (or None when the phone is hidden/unresolvable).
    hidden_mode is 'ai' (let the AI's tier check decide) or 'skip' (don't reply)."""
    if not enabled:
        return ALLOW
    if country is not None:
        return ALLOW if country in tier1 else REJECT_NON_TIER1
    return ALLOW if hidden_mode == "ai" else SKIP
