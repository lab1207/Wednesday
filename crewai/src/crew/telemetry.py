"""Turn off every upstream telemetry path, before crewai is imported.

WHY (operator rule, 2026-11-08: "no Google-analytics-style tracking code ...
make sure dot do this"): the crewai layer we ship imports upstream crewai and
runs a Crew. Upstream crewai installs an OpenTelemetry span exporter that
posts traces to a first-party collector, and upstream crewai requires
chromadb, whose product-analytics client is enabled by default
(`anonymized_telemetry` defaults to True). Both are ON unless something
turns them off.

WHY NOTHING HERE NAMES A VENDOR OR A HOST: this file ships in the npm
tarball (crewai/src/) and in the public GitHub tree, so it must not contain
a tracker hostname or a tracker brand -- a file that names the thing it
disables is a file that fails the rule it enforces. It names only the
environment variables and the settings field that upstream actually reads,
so a reader can audit the switch without the tree carrying an address.

WHY THE CALL IS EXPLICIT (disable_telemetry()) rather than an import side
effect: the call site then READS as the decision it is. A reader of
service.py sees the opt-out and sees that it precedes the crewai import,
without having to know what importing a module does.

WHY BEFORE THE IMPORT (this is load-bearing, not style):
  - upstream crewai's telemetry client reads these variables in its
    CONSTRUCTOR, and the client is built while the crewai package graph is
    being imported;
  - chromadb builds its Settings() at MODULE IMPORT time, and Settings is a
    pydantic BaseSettings, so `anonymized_telemetry` is read from the
    environment at that instant.
An opt-out applied after the import is applied to a client that is already
live.

WHY NOT os.environ.setdefault: setdefault lets an inherited value win. This
is a default we control and ship, so nothing in our code may phone home.
An operator who wants the upstream telemetry ON can still set it back
deliberately after the call; the shipped default is off.
"""
import os


def disable_telemetry() -> dict:
    """Turn off every telemetry path upstream crewai can reach.

    Returns the values that were set, so a caller can print or assert them.
    """
    optouts = {
        # The three upstream opt-outs crewai actually reads, in its telemetry
        # constructor and in the constructor of its shared core module.
        'OTEL_SDK_DISABLED': 'true',
        'CREWAI_DISABLE_TELEMETRY': 'true',
        'CREWAI_DISABLE_TRACKING': 'true',
        # chromadb's product analytics. Its Settings object is built at
        # import time, so this must be set before chromadb is imported --
        # which is what the call ordering in the calling module guarantees.
        'ANONYMIZED_TELEMETRY': 'False',
        # chromadb's own OTel collection endpoint. Empty means "collect
        # nowhere"; the upstream default is already empty, and we set it
        # explicitly so an inherited value cannot turn it on.
        'CHROMA_OTEL_COLLECTION_ENDPOINT': '',
        # PRECAUTION, NOT A LIVE OPT-OUT: the LLM layer upstream lazy-loads
        # an optional third-party client that is NOT in our resolution today
        # (it is absent from our lock file and from our environment). If a
        # future resolution adds it, its capture flag is already off.
        'LITELLM_TELEMETRY': 'False',
    }
    for name, value in optouts.items():
        os.environ[name] = value
    return dict(optouts)
