"""Tests for proxy identity resolution (auth._read_pomerium_identity).

This is the security-sensitive front door: it decides who the request is from
based on proxy-forwarded headers. The tricky bits are (a) preferring the signed
JWT assertion, (b) rejecting numeric IdP subject ids that some Pomerium versions
put in the name header, and (c) the legacy claim-header fallback.
"""
import base64
import json

from starlette.datastructures import Headers

from app.auth import _read_pomerium_identity, _looks_like_real_name


class _Req:
    """Minimal stand-in: _read_pomerium_identity only touches request.headers."""

    def __init__(self, headers: dict[str, str]):
        self.headers = Headers(headers)


def _jwt(claims: dict) -> str:
    payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    return f"header.{payload}.sig"


def test_jwt_assertion_email_and_name():
    req = _Req({"x-pomerium-jwt-assertion": _jwt({"email": "Vijay@NammaYatri.in", "name": "Vijay Gupta"})})
    assert _read_pomerium_identity(req) == ("vijay@nammayatri.in", "Vijay Gupta")


def test_jwt_assertion_builds_name_from_given_family():
    req = _Req({"x-pomerium-jwt-assertion": _jwt({"email": "a@b.com", "given_name": "Asha", "family_name": "Rao"})})
    assert _read_pomerium_identity(req) == ("a@b.com", "Asha Rao")


def test_jwt_assertion_falls_back_to_local_part_when_no_name():
    req = _Req({"x-pomerium-jwt-assertion": _jwt({"email": "ops@b.com"})})
    assert _read_pomerium_identity(req) == ("ops@b.com", "ops")


def test_legacy_claim_headers():
    req = _Req({"x-pomerium-claim-email": "C@D.com", "x-pomerium-claim-name": "Carol D"})
    assert _read_pomerium_identity(req) == ("c@d.com", "Carol D")


def test_numeric_subject_id_name_is_rejected():
    # Some Pomerium versions stuff the numeric IdP `sub` into the name header.
    req = _Req({"x-pomerium-claim-email": "e@f.com", "x-pomerium-user-name": "1098372645"})
    assert _read_pomerium_identity(req) == ("e@f.com", "e")


def test_no_identity_returns_none():
    assert _read_pomerium_identity(_Req({})) is None
    assert _read_pomerium_identity(_Req({"x-forwarded-for": "1.2.3.4"})) is None


def test_looks_like_real_name():
    assert _looks_like_real_name("Vijay Gupta") is True
    assert _looks_like_real_name("1098372645") is False
    assert _looks_like_real_name("a@b.com") is False
    assert _looks_like_real_name("") is False
    assert _looks_like_real_name(None) is False
