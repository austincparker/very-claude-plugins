"""Demo fixture for asn_lint.py -- exercises all six checks in one file.

Not a real module. Used by the plugin README to show a full run; also safe
to run by hand: `python3 ../asn_lint.py demo_target.py`.
"""


# Must hold at 3 retries -- the vendor API rate-limits after a 4th attempt.
RETRY_LIMIT = 3

# Removed the exponential backoff here because it was masking real outages.
def call_vendor(payload):
    return _send(payload)


def _send(payload):
    # response = client.post(payload)
    # if response.status_code >= 500:
    #     raise VendorError(response)
    return {"ok": True}


def add(a, b):
    """Add a and b."""
    return a + b


def handle_submit(event):
    return validate(event)


def handle_submitNew(event):
    return validate_v2(event)


def unused_formatter(value):
    return f"${value:.2f}"
