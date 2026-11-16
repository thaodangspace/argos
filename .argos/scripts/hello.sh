#!/bin/sh
# Demo script step: runs under a filtered environment (deny-by-default), in the
# run's cwd, and settles from its exit code.
echo "hello from the script step (argos + hc)"
echo "cwd: $(pwd)"
