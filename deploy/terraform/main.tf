# Installs Prooflix from the Helm chart in this repository. The chart stays the
# single description of the Kubernetes resources; Terraform only installs it.
#
# The image is built and loaded outside Terraform:
#   docker build -t prooflix:dev . && kind load docker-image prooflix:dev

locals {
  chart_path = "${path.module}/../helm/prooflix"

  # A hash of the chart's files, so editing a template triggers an upgrade
  chart_hash = sha1(join("", [
    for f in sort(fileset(local.chart_path, "**")) : filesha1("${local.chart_path}/${f}")
  ]))
}

resource "helm_release" "prooflix" {
  name             = var.release_name
  namespace        = var.namespace
  create_namespace = true
  chart            = local.chart_path

  # Wait until the pod passes its health check
  wait    = true
  timeout = 300

  values = [
    yamlencode({
      image = {
        repository = var.image_repository
        tag        = var.image_tag
        pullPolicy = var.image_pull_policy
      }
      prooflix = {
        scheduler = var.scheduler_enabled
      }
      persistence = {
        size         = var.persistence_size
        storageClass = var.storage_class
      }
      sourceData = {
        path = var.source_data_path
        volume = {
          enabled       = var.source_data_volume_enabled
          size          = var.source_data_volume_size
          storageClass  = var.storage_class
          existingClaim = var.source_data_existing_claim
        }
      }
      dataLake = {
        path = var.data_lake_path
        volume = {
          enabled       = var.data_lake_volume_enabled
          size          = var.data_lake_volume_size
          storageClass  = var.storage_class
          existingClaim = var.data_lake_existing_claim
        }
      }
      podAnnotations = {
        "prooflix/chart-hash" = local.chart_hash
      }
    }),
    yamlencode(var.extra_values),
  ]
}
