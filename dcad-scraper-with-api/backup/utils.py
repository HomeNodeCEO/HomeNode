import re

def normalize_account_id(raw: str) -> str:
    """
    Normalize and validate a DCAD account ID.
    Rules:
      - Must be 17 characters
      - Can include digits and letters (A–Z, 0–9)
      - Strips spaces and uppercases letters
    Returns the normalized ID if valid, else raises ValueError.
    """
    if not raw:
        raise ValueError("Account ID is required")

    acct = raw.strip().upper()

    if len(acct) != 17:
        raise ValueError(f"Account ID must be 17 characters, got {len(acct)}")

    if not re.match(r"^[A-Z0-9]{17}$", acct):
        raise ValueError("Account ID must contain only letters and digits")

    return acct
