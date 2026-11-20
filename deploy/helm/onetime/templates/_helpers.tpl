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
{{- if has $name (list "ONETIME_MAX_FILE_BYTES" "ONETIME_MAX_FILE_TTL") -}}
{{- fail (printf "extraEnv.%s is set by the chart: use config.maxFileBytes / config.maxFileTtl (the proxy body limit and timeouts follow from them)." $name) -}}
{{- end -}}
{{- end -}}
{{- $fb := .Values.config.maxFileBytes -}}
{{- if or (not (or (kindIs "float64" $fb) (kindIs "int64" $fb) (kindIs "int" $fb))) (lt (float64 $fb) 0.0) (gt (float64 $fb) 5242880.0) (ne (float64 $fb) (float64 (int64 $fb))) -}}
{{- fail (printf "config.maxFileBytes must be a whole number from 0 to 5242880 (got %v); 0 turns files off." $fb) -}}
{{- end -}}
{{- $ft := .Values.config.maxFileTtl -}}
{{- if or (not (or (kindIs "float64" $ft) (kindIs "int64" $ft) (kindIs "int" $ft))) (lt (float64 $ft) 60.0) (gt (float64 $ft) 604800.0) (ne (float64 $ft) (float64 (int64 $ft))) -}}
{{- fail (printf "config.maxFileTtl must be a whole number of seconds from 60 to 604800 (got %v)." $ft) -}}
{{- end -}}
{{- $override := toString (.Values.ingress.maxBodyBytes | default "") -}}
{{- if and (ne $override "") (lt (int64 .Values.ingress.maxBodyBytes) (int64 (include "onetime.fileBlobBytes" .))) -}}
{{- fail (printf "ingress.maxBodyBytes (%s) is below the largest blob of config.maxFileBytes (%s bytes): the proxy would refuse the largest allowed file. Leave it empty to derive it, or lower config.maxFileBytes." $override (include "onetime.fileBlobBytes" .)) -}}
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
{{- if and .Values.networkPolicy.enabled (empty .Values.networkPolicy.ingressFrom) -}}
{{- fail "networkPolicy.enabled needs networkPolicy.ingressFrom (who may reach port 8080, e.g. the ingress controller's namespace). An empty list would allow everyone." -}}
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

{{/* True when the Ingress class is served by ingress-nginx (community controller or the AKS application routing add-on). */}}
{{- define "onetime.ingressIsNginx" -}}
{{- $class := toString .Values.ingress.className -}}
{{- $annotated := false -}}
{{- range $k, $_ := .Values.ingress.annotations -}}
{{- if hasPrefix "nginx.ingress.kubernetes.io/" $k -}}{{- $annotated = true -}}{{- end -}}
{{- end -}}
{{- if or (contains "nginx" $class) (eq $class "webapprouting.kubernetes.azure.com") $annotated -}}true{{- end -}}
{{- end }}

{{/*
Largest request body of the app for config.maxFileBytes: fileBlobBytes() in src/shared/limits.ts. The file plus 388 bytes
of name and type must fit a padded block; the blob is the block plus 30 bytes. Never below a text blob (16,418 bytes),
which is also the limit with files off (0). 262144 -> 262,562; 5242880 -> 5,243,298.
*/}}
{{- define "onetime.fileBlobBytes" -}}
{{- $file := int64 .Values.config.maxFileBytes -}}
{{- $blob := 16418 -}}
{{- if gt $file 0 -}}
{{- $found := false -}}
{{- range $block := list 1024 4096 16388 65924 131460 262532 524676 1048964 2097540 4194692 5243268 -}}
{{- if and (not $found) (ge (int64 $block) (add $file 388)) -}}
{{- $found = true -}}
{{- $blob = max 16418 (add $block 30) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- $blob -}}
{{- end }}

{{/*
Proxy and ingress body limit in bytes: ingress.maxBodyBytes if set, else the largest blob plus 3 %, rounded up to the
next 100 KiB (102,400 bytes): 307200 (300 KiB) by default, 5427200 (5300 KiB) at 5 MiB, 102400 with files off.
*/}}
{{- define "onetime.proxyBodyBytes" -}}
{{- if ne (toString (.Values.ingress.maxBodyBytes | default "")) "" -}}
{{- int64 .Values.ingress.maxBodyBytes -}}
{{- else -}}
{{- $blob := int64 (include "onetime.fileBlobBytes" .) -}}
{{- mul (div (add (mul $blob 103) 10239999) 10240000) 102400 -}}
{{- end -}}
{{- end }}

{{/*
Proxy read/send timeout in seconds: ingress.proxyTimeoutSeconds if set, else the app's own request timeout
(60 s plus 1 s per 32 KiB of blob above a text blob, requestTimeoutMs in server/http.ts) plus 10 s, rounded up to
10 s: 80 by default, 230 at 5 MiB, 70 with files off.
*/}}
{{- define "onetime.proxyTimeoutSeconds" -}}
{{- if ne (toString (.Values.ingress.proxyTimeoutSeconds | default "")) "" -}}
{{- int64 .Values.ingress.proxyTimeoutSeconds -}}
{{- else -}}
{{- $blob := int64 (include "onetime.fileBlobBytes" .) -}}
{{- $app := add 60 (div (add (max 0 (sub $blob 16418)) 32767) 32768) -}}
{{- mul (div (add $app 19) 10) 10 -}}
{{- end -}}
{{- end }}
