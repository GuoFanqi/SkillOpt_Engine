from __future__ import annotations

import unicodedata


def validate_forbidden_terms(value: object) -> list[str]:
    if not isinstance(value, list) or any(not isinstance(term, str) or not term.strip() for term in value):
        raise ValueError("forbidden_terms must be a list of non-empty strings")
    return list(dict.fromkeys(term.strip() for term in value))


def check_forbidden_terms(text: str, terms: list[str]) -> list[str]:
    terms = validate_forbidden_terms(terms)
    normalized = unicodedata.normalize("NFKC", text).casefold()
    return [term for term in terms if unicodedata.normalize("NFKC", term).casefold() in normalized]
