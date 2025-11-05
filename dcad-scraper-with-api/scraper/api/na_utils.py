# scraper/api/na_utils.py
from typing import Any, Mapping, Sequence

def fill_na(obj: Any, na_value: str = "N/A", treat_blank_as_na: bool = True) -> Any:
    """
    Deeply replace None (and optionally blank strings) with a display sentinel like "N/A".
    - Leaves numbers, booleans, non-empty strings, and other types intact.
    - Works on nested dicts/lists.

    This is intended for API *responses only* so your DB can keep true NULLs.
    """
    # None -> "N/A"
    if obj is None:
        return na_value

    # Strings: optionally convert blanks to "N/A"
    if isinstance(obj, str):
        if treat_blank_as_na and obj.strip() == "":
            return na_value
        return obj

    # Dicts / mappings
    if isinstance(obj, Mapping):
        return {k: fill_na(v, na_value=na_value, treat_blank_as_na=treat_blank_as_na)
                for k, v in obj.items()}

    # Lists / tuples (but not strings/bytes)
    if isinstance(obj, Sequence) and not isinstance(obj, (str, bytes, bytearray)):
        return [fill_na(x, na_value=na_value, treat_blank_as_na=treat_blank_as_na) for x in obj]

    # Numbers, booleans, and any other types pass through unchanged
    return obj
