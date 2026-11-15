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

variable "max_depth" {
  description = "Maximum sub-pipeline nesting depth (PROOFLIX_MAX_DEPTH)"
  type        = number
  default     = 10
}

variable "start_date" {
  description = "Where data processing starts when the system is initialized, e.g. \"2026-01-01\" (PROOFLIX_START_DATE); empty processes all data"
  type        = string
  default     = ""
}

variable "spark_driver_memory" {
  description = "Memory of the Spark driver that runs pipeline tasks in the Prooflix pod (PROOFLIX_SPARK_DRIVER_MEMORY)"
  type        = string
  default     = "4g"
}

variable "unity_catalog_enabled" {
  description = "Run the open-source Unity Catalog server in the release (the catalog of the Delta tables)"
  type        = bool
  default     = true
}

variable "unity_catalog_uri" {
  description = "A Unity Catalog server that runs elsewhere; empty uses the one in the release"
  type        = string
  default     = ""
}

variable "unity_catalog_catalog" {
  description = "The tenant catalog pipelines write to (PROOFLIX_UC_CATALOG)"
  type        = string
  default     = "tenant1"
}

variable "clickhouse_enabled" {
  description = "Run ClickHouse in the release (the ClickHouse tab copies gold tables to it)"
  type        = bool
  default     = true
}

variable "clickhouse_service_type" {
  description = "How ClickHouse is reached from outside the cluster: ClusterIP (port-forward), NodePort or LoadBalancer"
  type        = string
  default     = "ClusterIP"
}

variable "clickhouse_public_url" {
  description = "The address outside users query ClickHouse at, shown in the ClickHouse tab (e.g. http://clickhouse.internal:8123)"
  type        = string
  default     = ""
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

variable "source_data_path" {
  description = "Source data folder in the pod (PROOFLIX_SOURCE_DATA: the raw files pipelines read); empty uses the source data volume's mount path, or each workspace's source/"
  type        = string
  default     = ""
}

variable "source_data_volume_enabled" {
  description = "Mount a volume holding the source files at /source-data (read-only)"
  type        = bool
  default     = false
}

variable "source_data_volume_size" {
  description = "Size of the source data volume, when the chart creates it"
  type        = string
  default     = "100Gi"
}

variable "source_data_existing_claim" {
  description = "Use this existing PVC (usually one already holding the files) for the source data volume"
  type        = string
  default     = ""
}

variable "data_lake_path" {
  description = "Data lake folder in the pod (PROOFLIX_DATA_LAKE: bronze, gold, checkpoints); empty uses the data lake volume's mount path, or each workspace's data/"
  type        = string
  default     = ""
}

variable "data_lake_volume_enabled" {
  description = "Mount a separate volume for the data lake at /datalake"
  type        = bool
  default     = false
}

variable "data_lake_volume_size" {
  description = "Size of the data lake volume"
  type        = string
  default     = "100Gi"
}

variable "data_lake_existing_claim" {
  description = "Use this existing PVC for the data lake volume instead of creating one"
  type        = string
  default     = ""
}

variable "extra_values" {
  description = "More chart values (see deploy/helm/prooflix/values.yaml), merged last"
  type        = any
  default     = {}
}
