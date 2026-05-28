"""Pin down the action-item diff helpers so we don't regress two real bugs:

1. Index-based row matching used to DM owners who had only shifted index
   (because the user reordered or inserted a row above them).
2. The status-change description used to fall through to a generic
   'Action Items' label whenever rows moved.

Both helpers now key on (category, action_text, occurrence).
"""
from app.api.rcas import (
    _action_item_owner_assignments,
    _describe_actions_diff,
    _diff_content_sections,
)


def _row(action: str, status: str = "Open", owners=None):
    return {"action": action, "status": status, "owners": owners or []}


def _user(email: str):
    return {"email": email, "name": email.split("@")[0]}


# --- owner-assignment diff ---------------------------------------------------


def test_assignments_on_create_lists_every_owner():
    new = {"Immediate Fixes": [_row("Raise pool", owners=[_user("a@x.com"), _user("b@x.com")])]}
    assert sorted(_action_item_owner_assignments(None, new)) == [
        ("a@x.com", "Raise pool"),
        ("b@x.com", "Raise pool"),
    ]


def test_assignments_adding_a_new_owner_DMs_only_the_new_one():
    old = {"Immediate Fixes": [_row("Raise pool", owners=[_user("a@x.com")])]}
    new = {"Immediate Fixes": [_row("Raise pool", owners=[_user("a@x.com"), _user("b@x.com")])]}
    assert _action_item_owner_assignments(old, new) == [("b@x.com", "Raise pool")]


def test_assignments_reordering_rows_does_NOT_redm_existing_owners():
    """The original bug: reorder caused row 0's owner to look 'new' at row 1's slot."""
    a = _row("A", owners=[_user("a@x.com")])
    b = _row("B", owners=[_user("b@x.com")])
    old = {"Immediate Fixes": [a, b]}
    new = {"Immediate Fixes": [b, a]}  # swap order
    assert _action_item_owner_assignments(old, new) == []


def test_assignments_inserting_a_row_above_an_existing_one_does_NOT_redm():
    a = _row("A", owners=[_user("a@x.com")])
    new_row = _row("New", owners=[_user("n@x.com")])
    old = {"Immediate Fixes": [a]}
    new = {"Immediate Fixes": [new_row, a]}  # insert at top
    assert _action_item_owner_assignments(old, new) == [("n@x.com", "New")]


def test_assignments_removing_an_owner_emits_nothing():
    old = {"Immediate Fixes": [_row("X", owners=[_user("a@x.com")])]}
    new = {"Immediate Fixes": [_row("X", owners=[])]}
    assert _action_item_owner_assignments(old, new) == []


def test_assignments_pure_status_flip_emits_nothing():
    old = {"Immediate Fixes": [_row("X", status="Open", owners=[_user("a@x.com")])]}
    new = {"Immediate Fixes": [_row("X", status="Closed", owners=[_user("a@x.com")])]}
    assert _action_item_owner_assignments(old, new) == []


def test_assignments_legacy_single_owner_vs_owners_list_is_treated_as_same():
    old = {"Immediate Fixes": [{"action": "X", "status": "Open", "owner": _user("a@x.com")}]}
    new = {"Immediate Fixes": [_row("X", owners=[_user("a@x.com")])]}
    assert _action_item_owner_assignments(old, new) == []


def test_assignments_skip_owners_without_email():
    new = {"Immediate Fixes": [_row("X", owners=[{"email": "", "name": "Anon"}])]}
    assert _action_item_owner_assignments(None, new) == []


def test_assignments_emails_normalized_to_lowercase():
    new = {"Immediate Fixes": [_row("X", owners=[_user("VIJ@X.com")])]}
    assert _action_item_owner_assignments(None, new) == [("vij@x.com", "X")]


# --- status-change description ----------------------------------------------


def test_status_describe_single_flip_names_the_item():
    old = {"Immediate Fixes": [_row("Raise pool", status="Open", owners=[_user("a@x.com")])]}
    new = {"Immediate Fixes": [_row("Raise pool", status="Closed", owners=[_user("a@x.com")])]}
    assert _describe_actions_diff(old, new) == 'marked "Raise pool" as Closed'


def test_status_describe_collapses_multiline_action_in_label():
    """A multi-line action description must read as a single tidy line in the
    timeline label (and avoid breaking the title attribute)."""
    old = {"Immediate Fixes": [_row("Raise pool size\nFrom 20 to 60 connections", status="Open")]}
    new = {"Immediate Fixes": [_row("Raise pool size\nFrom 20 to 60 connections", status="Closed")]}
    label = _describe_actions_diff(old, new)
    assert label == 'marked "Raise pool size From 20 to 60 connections" as Closed'
    assert "\n" not in label


def test_status_describe_truncates_very_long_action_text():
    long = "x" * 200
    old = {"Immediate Fixes": [_row(long, status="Open")]}
    new = {"Immediate Fixes": [_row(long, status="Closed")]}
    label = _describe_actions_diff(old, new)
    assert label.endswith('…" as Closed')
    assert len(label) < 100


def test_status_describe_multiple_flips_counts_them():
    old = {
        "Immediate Fixes": [
            _row("A", status="Open"),
            _row("B", status="Open"),
        ]
    }
    new = {
        "Immediate Fixes": [
            _row("A", status="Closed"),
            _row("B", status="Done"),
        ]
    }
    assert _describe_actions_diff(old, new) == "updated 2 action item statuses"


def test_status_describe_falls_back_when_structure_changes():
    old = {"Immediate Fixes": [_row("A", status="Open")]}
    new = {"Immediate Fixes": [_row("A", status="Open"), _row("B", status="Open")]}
    assert _describe_actions_diff(old, new) == "Action Items"


def test_status_describe_pure_reorder_does_not_claim_a_status_flip():
    """The important property is: a pure reorder must NOT produce a misleading
    'marked X as Y' line. It still IS a real edit (the persisted array order
    composes into the body), so the generic 'Action Items' label is correct."""
    a = _row("A", status="Open")
    b = _row("B", status="Open")
    label = _describe_actions_diff({"X": [a, b]}, {"X": [b, a]})
    assert label == "Action Items"
    assert label is not None and "marked" not in label


# --- content section diff (uses _describe_actions_diff internally) ----------


def test_content_diff_summary_only():
    old = {"summary": "a", "actions": {}}
    new = {"summary": "b", "actions": {}}
    assert _diff_content_sections(old, new) == ["Summary"]


def test_content_diff_status_flip_appears_under_actions():
    old = {"summary": "x", "actions": {"Immediate Fixes": [_row("Raise pool", status="Open")]}}
    new = {"summary": "x", "actions": {"Immediate Fixes": [_row("Raise pool", status="Closed")]}}
    assert _diff_content_sections(old, new) == ['marked "Raise pool" as Closed']


def test_content_diff_no_change_returns_empty():
    same = {"summary": "x", "actions": {"Immediate Fixes": [_row("A")]}}
    assert _diff_content_sections(same, same) == []
