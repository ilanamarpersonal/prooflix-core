output "namespace" {
  value = helm_release.prooflix.namespace
}

output "release_status" {
  value = helm_release.prooflix.status
}

output "open" {
  description = "Command to reach Prooflix at http://localhost:8000"
  value       = "kubectl --context ${var.kube_context} --namespace ${var.namespace} port-forward svc/${var.release_name} 8000:8000"
}
