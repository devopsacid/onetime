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

variable "max_file_bytes" {
  description = "config.maxFileBytes of the chart (ONETIME_MAX_FILE_BYTES): largest file in bytes, 0..5242880; 0 turns files off. The chart derives the ingress body limit and timeouts from it. null = not set here: config.maxFileBytes from base_values/values applies, else the chart default (262144). A number wins over base_values and values."
  type        = number
  default     = null
  validation {
    condition     = var.max_file_bytes == null || (var.max_file_bytes >= 0 && var.max_file_bytes <= 5242880 && floor(var.max_file_bytes) == var.max_file_bytes)
    error_message = "max_file_bytes must be null or a whole number from 0 to 5242880 (0 turns files off)."
  }
}

variable "max_file_ttl" {
  description = "config.maxFileTtl of the chart (ONETIME_MAX_FILE_TTL): longest life of a file in seconds, 60..604800. null = not set here: config.maxFileTtl from base_values/values applies, else the chart default (3600). A number wins over base_values and values."
  type        = number
  default     = null
  validation {
    condition     = var.max_file_ttl == null || (var.max_file_ttl >= 60 && var.max_file_ttl <= 604800 && floor(var.max_file_ttl) == var.max_file_ttl)
    error_message = "max_file_ttl must be null or a whole number of seconds from 60 to 604800."
  }
}

variable "base_values" {
  description = "YAML documents applied first, e.g. file(\"deploy/helm/examples/values-eks.yaml\"). The image, host, storage class and file inputs override them."
  type        = list(string)
  default     = []
}

variable "values" {
  description = "Values as an object, merged after base_values and before the image/host/storage/file inputs."
  type        = any
  default     = {}
}

variable "timeout" {
  description = "Seconds Helm waits for the pod to become ready."
  type        = number
  default     = 300
}
