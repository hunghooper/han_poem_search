# packages/config

Runtime configuration: thresholds, model names, agent budgets, which retrievers participate.

`config/runtime.yaml` holds the project defaults. A browser can override most of them for its
own session; those overrides travel with the request and never write the file.

The distinction matters because most of these numbers are not calibrated. Changing a project
default should require a recorded calibration; experimenting in your own browser should not.
