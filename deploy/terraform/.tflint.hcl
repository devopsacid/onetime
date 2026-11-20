# tflint configuration for deploy/terraform. Run from a module or example folder:
#   tflint --init --config "$(git rev-parse --show-toplevel)/deploy/terraform/.tflint.hcl"
#   tflint --config "$(git rev-parse --show-toplevel)/deploy/terraform/.tflint.hcl"
config {
  call_module_type = "local"
}

plugin "terraform" {
  enabled = true
  preset  = "recommended"
}

plugin "aws" {
  enabled = true
  version = "0.50.0"
  source  = "github.com/terraform-linters/tflint-ruleset-aws"
}

plugin "azurerm" {
  enabled = true
  version = "0.33.0"
  source  = "github.com/terraform-linters/tflint-ruleset-azurerm"
}

plugin "google" {
  enabled = true
  version = "0.41.0"
  source  = "github.com/terraform-linters/tflint-ruleset-google"
}
