variable "kubeconfig_path" {
  description = "kubeconfig file to use"
  type        = string
  default     = "~/.kube/config"
}

variable "kube_context" {
  description = "kubeconfig context of the cluster to install into"
  type        = string
  default     = "kind-kind"
}

variable "namespace" {
  description = "Namespace for the release (created if missing)"
  type        = string
  default     = "default"
}

variable "release_name" {
  description = "Helm release name; also names the Deployment, Service and PVC"
  type        = string
  default     = "prooflix"
}

variable "image_repository" {
  description = "Prooflix image repository"
  type        = string
  default     = "prooflix"
}

variable "image_tag" {
  description = "Prooflix image tag"
  type        = string
  default     = "dev"
}

variable "image_pull_policy" {
  description = "Never for an image loaded with `kind load docker-image`; IfNotPresent or Always for a registry"
  type        = string
  default     = "Never"

  validation {
    condition     = contains(["Always", "IfNotPresent", "Never"], var.image_pull_policy)
    error_message = "image_pull_policy must be Always, IfNotPresent or Never."
  }
}

variable "scheduler_enabled" {
  description = "Run pipelines on their cron schedules"
  type        = bool
  default     = true
}

variable "persistence_size" {
  description = "Size of the volume holding the workspace and catalog"
  type        = string
  default     = "10Gi"
}

variable "storage_class" {
  description = "StorageClass for the volume; empty uses the cluster default"
  type        = string
  default     = ""
}

variable "extra_values" {
  description = "More chart values (see deploy/helm/prooflix/values.yaml), merged last"
  type        = any
  default     = {}
}
