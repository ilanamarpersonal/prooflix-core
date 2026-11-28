{{- define "prooflix.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "prooflix.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "prooflix.selectorLabels" -}}
app.kubernetes.io/name: {{ include "prooflix.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "prooflix.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{ include "prooflix.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "prooflix.claimName" -}}
{{- default (include "prooflix.fullname" .) .Values.persistence.existingClaim }}
{{- end }}

{{/*
The data lake PVC name.
*/}}
{{- define "prooflix.dataLakeClaimName" -}}
{{- if .Values.dataLake.volume.existingClaim }}
{{- .Values.dataLake.volume.existingClaim }}
{{- else }}
{{- printf "%s-datalake" (include "prooflix.fullname" .) }}
{{- end }}
{{- end }}

{{/*
PROOFLIX_DATA_LAKE: dataLake.path, else the data lake volume's mount path, else "" (each workspace's data/).
*/}}
{{- define "prooflix.dataLakePath" -}}
{{- if .Values.dataLake.path }}
{{- .Values.dataLake.path }}
{{- else if .Values.dataLake.volume.enabled }}
{{- .Values.dataLake.volume.mountPath }}
{{- end }}
{{- end }}

{{/*
The source data PVC name.
*/}}
{{- define "prooflix.sourceDataClaimName" -}}
{{- if .Values.sourceData.volume.existingClaim }}
{{- .Values.sourceData.volume.existingClaim }}
{{- else }}
{{- printf "%s-source-data" (include "prooflix.fullname" .) }}
{{- end }}
{{- end }}

{{/*
PROOFLIX_SOURCE_DATA: sourceData.path, else the source data volume's mount path, else "" (each workspace's source/).
*/}}
{{- define "prooflix.sourceDataPath" -}}
{{- if .Values.sourceData.path }}
{{- .Values.sourceData.path }}
{{- else if .Values.sourceData.volume.enabled }}
{{- .Values.sourceData.volume.mountPath }}
{{- end }}
{{- end }}


{{/* The Unity Catalog server the pipelines use */}}
{{- define "prooflix.unityCatalogUri" -}}
{{- if .Values.unityCatalog.uri }}
{{- .Values.unityCatalog.uri }}
{{- else if .Values.unityCatalog.enabled }}
{{- printf "http://%s-unitycatalog:%v" (include "prooflix.fullname" .) .Values.unityCatalog.port }}
{{- end }}
{{- end }}

{{- define "prooflix.unityCatalogClaimName" -}}
{{- if .Values.unityCatalog.persistence.existingClaim }}
{{- .Values.unityCatalog.persistence.existingClaim }}
{{- else }}
{{- printf "%s-unitycatalog" (include "prooflix.fullname" .) }}
{{- end }}
{{- end }}

{{/* Its own name label, so the Prooflix Service never selects the Unity Catalog pod */}}
{{- define "prooflix.unityCatalogSelectorLabels" -}}
app.kubernetes.io/name: {{ include "prooflix.name" . }}-unitycatalog
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: unitycatalog
{{- end }}

{{/* ClickHouse */}}
{{- define "prooflix.clickhouseName" -}}
{{- printf "%s-clickhouse" (include "prooflix.fullname" .) }}
{{- end }}

{{- define "prooflix.clickhouseSecretName" -}}
{{- .Values.clickhouse.auth.existingSecret | default (include "prooflix.clickhouseName" .) }}
{{- end }}

{{- define "prooflix.clickhouseSelectorLabels" -}}
app.kubernetes.io/name: {{ include "prooflix.name" . }}-clickhouse
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: clickhouse
{{- end }}

{{- define "prooflix.postgresName" -}}
{{- printf "%s-postgres" (include "prooflix.fullname" .) }}
{{- end }}

{{- define "prooflix.postgresSecretName" -}}
{{- .Values.postgres.auth.existingSecret | default (include "prooflix.postgresName" .) }}
{{- end }}

{{- define "prooflix.postgresSelectorLabels" -}}
app.kubernetes.io/name: {{ include "prooflix.name" . }}-postgres
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: postgres
{{- end }}

{{- define "prooflix.opensearchName" -}}
{{- printf "%s-opensearch" (include "prooflix.fullname" .) }}
{{- end }}

{{- define "prooflix.opensearchSelectorLabels" -}}
app.kubernetes.io/name: {{ include "prooflix.name" . }}-opensearch
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: opensearch
{{- end }}
