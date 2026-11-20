{{/* Chart name, truncated to 63 characters. */}}
{{- define "onetime.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Fully qualified app name. */}}
{{- define "onetime.fullname" -}}
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

{{- define "onetime.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "onetime.labels" -}}
helm.sh/chart: {{ include "onetime.chart" . }}
{{ include "onetime.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/* Selector of the server pod. The component label keeps the helm test pod out of it. */}}
{{- define "onetime.selectorLabels" -}}
app.kubernetes.io/name: {{ include "onetime.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: server
{{- end }}

{{- define "onetime.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "onetime.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/* Image reference: repository is required, and a tag or a digest. */}}
{{- define "onetime.image" -}}
{{- $repo := required "image.repository is required: there is no published image. Build your own with ONETIME_ORIGIN and push it (docs/deploy-helm.md)." .Values.image.repository -}}
{{- $tag := toString (.Values.image.tag | default "") -}}
{{- $digest := toString (.Values.image.digest | default "") -}}
{{- if and (eq $tag "") (eq $digest "") -}}
{{- fail "image.tag or image.digest is required (prefer image.digest)." -}}
{{- end -}}
{{- if and (ne $digest "") (not (regexMatch "^sha256:[a-f0-9]{64}$" $digest)) -}}
{{- fail "image.digest must look like sha256:<64 hex characters>." -}}
{{- end -}}
{{- $repo -}}
{{- if ne $tag "" }}:{{ $tag }}{{ end -}}
{{- if ne $digest "" }}@{{ $digest }}{{ end -}}
{{- end }}

{{/* Guards that must hold whatever the schema says (helm --skip-schema-validation skips the schema). */}}
{{- define "onetime.validate" -}}
{{- if ne (int .Values.replicaCount) 1 -}}
{{- fail (printf "replicaCount must be 1 (got %v): onetime keeps its data in one SQLite file with an exclusive lock. A second pod would exit with code 3; replicas and autoscaling are not supported." .Values.replicaCount) -}}
{{- end -}}
{{- range $name, $_ := .Values.extraEnv -}}
{{- if has $name (list "HOST" "PORT" "ONETIME_DB") -}}
{{- fail (printf "extraEnv.%s is set by the chart (HOST, PORT and ONETIME_DB are fixed; the database path is config.dbPath)." $name) -}}
{{- end -}}
{{- end -}}
{{- if and .Values.persistence.enabled (has "ReadWriteMany" .Values.persistence.accessModes) -}}
{{- fail "persistence.accessModes must not contain ReadWriteMany: the database needs block or local storage, not a shared filesystem." -}}
{{- end -}}
{{- if and .Values.ingress.enabled (eq (toString .Values.ingress.host) "") -}}
{{- fail "ingress.host is required when ingress.enabled is true (the host must match the ONETIME_ORIGIN the image was built with)." -}}
{{- end -}}
{{- if and .Values.ingress.certManager.enabled (eq (toString .Values.ingress.certManager.issuerName) "") -}}
{{- fail "ingress.certManager.issuerName is required when ingress.certManager.enabled is true." -}}
{{- end -}}
{{- if and .Values.ingress.certManager.enabled (eq (toString .Values.ingress.tlsSecretName) "") -}}
{{- fail "ingress.tlsSecretName is required when ingress.certManager.enabled is true (cert-manager stores the certificate there)." -}}
{{- end -}}
{{- if and .Values.gke.managedCertificate.enabled (not .Values.ingress.enabled) -}}
{{- fail "gke.managedCertificate needs ingress.enabled and ingress.host." -}}
{{- end -}}
{{- end }}

{{/* Renders a map of annotations with every value as a string (helm --set turns numbers into numbers). */}}
{{- define "onetime.stringMap" -}}
{{- $lines := list -}}
{{- range $k, $v := . -}}
{{- $lines = append $lines (printf "%s: %s" $k ($v | toString | quote)) -}}
{{- end -}}
{{- join "\n" $lines -}}
{{- end }}
