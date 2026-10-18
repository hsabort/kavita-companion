#!/usr/bin/env python3
"""The capability probe: the portal reports which optional tools this image carries.

The shared test stack runs the formats image, so both optional capabilities are present here. The
default image's absences are asserted separately by Task 8 (tests/test_default_image.py); this file
only pins the probe and the health response shape.

Run: python3 tests/test_capabilities.py
"""
import sys

from harness import app, check, finish

status, body = app("GET", "/api/health")
check("health still answers ok", status == 200 and body.get("ok") is True, f"{status} {body}")
check("health still reports Kavita reachability", body.get("kavita") == "reachable", str(body))

caps = body.get("capabilities")
check("health reports a capability set", isinstance(caps, dict), str(body))
check("zip is always present (read in-process)", caps is not None and caps.get("zip") is True, str(caps))
check("the formats stack has 7-Zip (archive extras)",
      caps is not None and caps.get("archiveExtras") is True, str(caps))
check("the formats stack has KindleUnpack (kindle)",
      caps is not None and caps.get("kindle") is True, str(caps))

sys.exit(finish())
