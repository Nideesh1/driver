"""
The specification for :mod:`driverkit.auth`.

Unit tests, unlike the rest of the relay suite, and deliberately: these pin the
token format and the refusal rules, which are the things an attacker interacts
with directly and which a test over HTTP would only exercise through whichever
paths the relay happens to take. ``test_relay_auth.py`` is the HTTP half and
asserts what the relay DOES with the answers here.

Each name states the decision it pins.
"""

from __future__ import annotations

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))

from driverkit.auth import (  # noqa: E402
    ANON_ID_PREFIX,
    MIN_SECRET_BYTES,
    AuthError,
    TabAuth,
    anon_principal_id,
    mint_anon_credential,
)

SECRET = "s" * 40
OTHER = "o" * 40


def auth(**extra) -> TabAuth:
    extra.setdefault("audience", "relay-prod")
    extra.setdefault("secret", SECRET)
    return TabAuth(**extra)


def tamper(token: str, *, claims: dict | None = None, signature: str | None = None) -> str:
    """A token with its payload or its signature rewritten.

    Written out rather than fuzzed because the two interesting forgeries are
    specific: an attacker who edits claims and keeps the signature, and one who
    edits the signature. Both must fail, and for different reasons.
    """
    import base64

    prefix, body, sig = token.split(".")
    if claims is not None:
        current = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
        current.update(claims)
        raw = json.dumps(current, sort_keys=True, separators=(",", ":")).encode()
        body = base64.urlsafe_b64encode(raw).decode().rstrip("=")
    return f"{prefix}.{body}.{signature if signature is not None else sig}"


class Format(unittest.TestCase):
    def test_a_token_names_its_principal_audience_and_lifetime(self):
        who = auth().principal(auth().mint("user:42"))
        self.assertEqual(who.id, "user:42")
        self.assertIsNone(who.tab)
        self.assertFalse(who.anonymous)

    def test_the_algorithm_is_the_prefix_and_not_a_field_in_the_payload(self):
        # The deliberate departure from JWT. A JWT names its own algorithm in a
        # header the verifier has not authenticated yet, which is the root of
        # the `alg: none` family of bugs. Here there is nothing to negotiate:
        # a credential starts with `dkt1.` or it is not a credential, so the
        # classic downgrade has nowhere to be written.
        token = auth().mint("user:42")
        self.assertTrue(token.startswith("dkt1."))
        payload = json.loads(
            __import__("base64").urlsafe_b64decode(
                token.split(".")[1] + "=" * (-len(token.split(".")[1]) % 4)
            )
        )
        self.assertNotIn("alg", payload)
        self.assertEqual(sorted(payload), ["aud", "exp", "iat", "kid", "sub"])

        # And relabelling the prefix does not produce a valid `dkt2`: the
        # prefix is inside the MAC, so there is no version a payload can be
        # moved to.
        with self.assertRaises(AuthError):
            auth().principal("dkt2." + token.split(".", 1)[1])

    def test_a_tampered_payload_fails_even_though_the_signature_is_untouched(self):
        a = auth()
        forged = tamper(a.mint("user:42"), claims={"sub": "user:1"})
        with self.assertRaises(AuthError):
            a.principal(forged)

    def test_a_rewritten_signature_fails(self):
        a = auth()
        with self.assertRaises(AuthError):
            a.principal(tamper(a.mint("user:42"), signature="AAAA"))
        with self.assertRaises(AuthError):
            a.principal(tamper(a.mint("user:42"), signature=""))

    def test_a_token_signed_with_another_key_fails(self):
        mine = auth()
        theirs = TabAuth(secret=OTHER, audience="relay-prod")
        with self.assertRaises(AuthError):
            mine.principal(theirs.mint("user:42"))

    def test_a_token_for_another_audience_fails_even_with_the_right_key(self):
        # The case that happens the first time somebody copies an env file:
        # staging and production share a secret, and without this check a
        # staging token is a production token.
        staging = TabAuth(secret=SECRET, audience="relay-staging")
        with self.assertRaises(AuthError):
            auth().principal(staging.mint("user:42"))

    def test_garbage_is_refused_rather_than_decoded_into_a_principal(self):
        a = auth()
        for credential in (
            "",
            "   ",
            "hello",
            "dkt1",
            "dkt1.x",
            "dkt1.a.b.c",
            "dkt1...",
            "dkt1.!!!!.!!!!",
            # A payload that is valid base64 of valid JSON that is not an object.
            "dkt1.WyJhIl0.AAAA",
        ):
            with self.subTest(credential=credential), self.assertRaises(AuthError):
                a.principal(credential)


class Lifetime(unittest.TestCase):
    def test_an_expired_token_is_refused(self):
        a = auth(ttl_s=60, skew_s=0)
        token = a.mint("user:42", now=1_000_000)
        self.assertEqual(a.principal(token, now=1_000_030).id, "user:42")
        with self.assertRaises(AuthError):
            a.principal(token, now=1_000_061)

    def test_clock_skew_is_tolerated_on_expiry_and_bounded(self):
        # Two hosts mint and verify, so a second of drift must not invalidate a
        # fresh token. The window is bounded because skew tolerance is a direct
        # extension of every token's lifetime.
        a = auth(ttl_s=60, skew_s=30)
        token = a.mint("user:42", now=1_000_000)
        self.assertEqual(a.principal(token, now=1_000_089).id, "user:42")
        with self.assertRaises(AuthError):
            a.principal(token, now=1_000_091)

    def test_a_token_from_the_future_is_not_evidence(self):
        # A minter with a wrong clock would otherwise issue credentials that
        # outlive their stated lifetime by however far the clock is out.
        a = auth(skew_s=30)
        token = a.mint("user:42", now=2_000_000)
        with self.assertRaises(AuthError):
            a.principal(token, now=2_000_000 - 31)
        self.assertEqual(a.principal(token, now=2_000_000 - 29).id, "user:42")


class Keys(unittest.TestCase):
    def test_a_key_shorter_than_the_minimum_is_refused_at_construction(self):
        # The moment to say an HMAC key is theatre is before it is deployed.
        with self.assertRaises(ValueError) as caught:
            TabAuth(secret="short", audience="relay-prod")
        self.assertIn(str(MIN_SECRET_BYTES), str(caught.exception))

    def test_an_audience_is_required_and_has_no_default(self):
        # A default audience is an audience nobody chose, and two relays that
        # both accept it are one relay as far as a stolen token is concerned.
        with self.assertRaises(ValueError):
            TabAuth(secret=SECRET, audience="")

    def test_rotation_accepts_both_keys_while_minting_with_one(self):
        old, new = "a" * 40, "b" * 40
        # Step 1: the relay knows both; nothing mints with the new one yet.
        relay = TabAuth(keys={"k1": old, "k2": new}, active_kid="k1", audience="relay-prod")
        minter_old = TabAuth(secret=old, audience="relay-prod")
        minter_new = TabAuth(keys={"k2": new}, audience="relay-prod")
        self.assertEqual(relay.principal(minter_old.mint("user:42")).id, "user:42")
        # Step 2: the minter switches. The same relay accepts it with no change.
        self.assertEqual(relay.principal(minter_new.mint("user:42")).id, "user:42")
        # Step 3: the old key is dropped. Tokens signed with it stop working,
        # which is why the wait before this step is `ttl + skew`.
        dropped = TabAuth(keys={"k2": new}, audience="relay-prod")
        with self.assertRaises(AuthError):
            dropped.principal(minter_old.mint("user:42"))

    def test_an_unknown_key_id_is_refused_and_the_other_keys_are_not_tried(self):
        # "Try them all" would turn a rotation window into a period where every
        # key is live for every token, which is the opposite of rotating.
        relay = TabAuth(keys={"k1": SECRET}, audience="relay-prod")
        forged = tamper(relay.mint("user:42"), claims={"kid": "k9"})
        with self.assertRaises(AuthError):
            relay.principal(forged)


class Binding(unittest.TestCase):
    def test_a_tab_claim_rides_through_to_the_principal(self):
        who = auth().principal(auth().mint("user:42", tab="tab-7"))
        self.assertEqual((who.id, who.tab), ("user:42", "tab-7"))

    def test_a_relay_may_require_the_binding(self):
        strict = auth(require_tab_binding=True)
        self.assertEqual(strict.principal(strict.mint("user:42", tab="t")).tab, "t")
        with self.assertRaises(AuthError):
            strict.principal(strict.mint("user:42"))

    def test_the_binding_is_not_required_by_default(self):
        # Because the tab mints its own id, so binding costs the page a round
        # trip it cannot make at render time. The cost and what it buys are
        # argued in TabAuth.mint.
        self.assertIsNone(auth().principal(auth().mint("user:42")).tab)


class Anonymous(unittest.TestCase):
    def test_two_anonymous_visitors_are_two_principals(self):
        # The requirement: "anonymous" must not be one shared bucket. Two
        # independent secrets are two independent principals, and the relay
        # keys its registry on the principal, so neither can see the other.
        a = auth()
        one = a.principal(mint_anon_credential())
        two = a.principal(mint_anon_credential())
        self.assertNotEqual(one.id, two.id)
        self.assertTrue(one.anonymous and two.anonymous)
        self.assertTrue(one.id.startswith(ANON_ID_PREFIX))

    def test_the_same_secret_is_the_same_principal_across_relays_and_rotations(self):
        # Keyless derivation. Deriving it with the HMAC key would mean every
        # anonymous visitor's identity changed the day a key rotated, and the
        # keying would buy nothing: the only party who could correlate a
        # principal id with a secret already holds the secret.
        credential = mint_anon_credential()
        rotated = TabAuth(keys={"k9": OTHER}, audience="relay-prod")
        self.assertEqual(
            auth().principal(credential).id,
            rotated.principal(credential).id,
        )
        self.assertEqual(anon_principal_id(credential), auth().principal(credential).id)

    def test_the_principal_id_does_not_reveal_the_secret(self):
        credential = mint_anon_credential()
        secret = credential.split(".", 1)[1]
        self.assertNotIn(secret, auth().principal(credential).id)

    def test_a_short_anonymous_secret_is_refused(self):
        # A guessable anonymous principal is the shared bucket this design
        # exists to avoid, so a secret too short to be unguessable is not a
        # weaker credential — it is no credential.
        with self.assertRaises(AuthError):
            auth().principal("anon1.abc")

    def test_an_app_with_real_users_can_refuse_anonymous_entirely(self):
        strict = auth(anonymous=False)
        with self.assertRaises(AuthError):
            strict.principal(mint_anon_credential())
        # And a real token still works, so turning it off is not turning auth off.
        self.assertEqual(strict.principal(strict.mint("user:42")).id, "user:42")

    def test_a_signed_token_may_not_claim_an_anonymous_principal(self):
        # Otherwise the two kinds of credential stop being distinguishable,
        # which is the one thing `Principal.anonymous` is for.
        a = auth()
        with self.assertRaises(ValueError):
            a.mint(f"{ANON_ID_PREFIX}deadbeef")
        forged = tamper(a.mint("user:42"), claims={"sub": f"{ANON_ID_PREFIX}deadbeef"})
        with self.assertRaises(AuthError):
            a.principal(forged)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
