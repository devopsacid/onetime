variable "release_name" {
  description = "Helm release name."
  type        = string
  default     = "onetime"
}

variable "namespace" {
  description = "Namespace for the release."
  type        = string
  default     = "onetime"
}

variable "create_namespace" {
  description = "Create the namespace if it does not exist."
  type        = bool
  default     = true
}

variable "chart_path" {
  description = "Path to the onetime chart. Default: deploy/helm/onetime in this repository."
  type        = string
  default     = null
}

variable "image_repository" {
  description = "Your own onetime image repository (there is no published image)."
  type        = string
  validation {
    condition     = length(var.image_repository) > 0
    error_message = "image_repository is required: build your own image with ONETIME_ORIGIN and push it."
  }
}

variable "image_digest" {
  description = "Image digest (sha256:...). Preferred over a tag."
  type        = string
  default     = ""
  validation {
    condition     = var.image_digest == "" || can(regex("^sha256:[a-f0-9]{64}$", var.image_digest))
    error_message = "image_digest must look like sha256:<64 hex characters>."
  }
}

variable "image_tag" {
  description = "Image tag, if no digest is given."
  type        = string
  default     = ""
  validation {
    condition     = var.image_tag != "" || var.image_digest != ""
    error_message = "Set image_digest (preferred) or image_tag."
  }
}

variable "host" {
  description = "Public host name for the Ingress. Must equal the host of the ONETIME_ORIGIN the image was built with. null = no Ingress."
  type        = string
  default     = null
}

variable "storage_class" {
  description = "StorageClass of the data volume: block or local storage only (gp3, managed-csi, standard-rwo, local-path, longhorn). null = the base values or the cluster default."
  type        = string
  default     = null
}

variable "base_values" {
  description = "YAML documents applied first, e.g. file(\"deploy/helm/examples/values-eks.yaml\"). The image, host and storage class inputs override them."
  type        = list(string)
  default     = []
}

variable "values" {
  description = "Values as an object, merged after base_values and before the image/host/storage inputs."
  type        = any
  default     = {}
}

variable "timeout" {
  description = "Seconds Helm waits for the pod to become ready."
  type        = number
  default     = 300
}
