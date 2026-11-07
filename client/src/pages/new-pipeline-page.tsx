import { useState } from "react"
import { Link, useNavigate } from "react-router"

import { PageHeader } from "@/components/page-header"
import { YamlEditor } from "@/components/yaml-editor"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

const TEMPLATE = `name: My pipeline
description: Calls an existing pipeline, then runs a shell step
parameters:
  who: world

tasks:
  - key: hello
    type: pipeline
    pipeline: hello_world
    parameters:
      who: \${params.who}

  - key: done
    type: shell
    depends_on: [hello]
    command: echo "sub-pipeline finished"
`

const ID_RE = /^[a-z0-9][a-z0-9_-]*$/

export function NewPipelinePage() {
  const navigate = useNavigate()
  const [id, setId] = useState("my_pipeline")
  const idValid = ID_RE.test(id)

  return (
    <>
      <PageHeader
        eyebrow={
          <Link to="/pipelines" className="hover:underline">
            Pipelines
          </Link>
        }
        title="New pipeline"
        description="Saved as workspace/pipelines/<id>.yaml. Other pipelines call it by this id."
      />
      <div className="mb-4 grid max-w-sm gap-1.5">
        <Label htmlFor="pipeline-id">Pipeline id</Label>
        <Input
          id="pipeline-id"
          value={id}
          onChange={(e) => setId(e.target.value.trim())}
          aria-invalid={!idValid}
          className="font-mono"
        />
        {!idValid && (
          <p className="text-destructive text-xs">Use lowercase letters, digits, “_” or “-”.</p>
        )}
      </div>
      {/* An invalid id is sent as-is so the server reports it as a validation error. */}
      <YamlEditor
        pipelineId={id || "_"}
        savedSource={null}
        startingSource={TEMPLATE}
        onSaved={(d) => navigate(`/pipelines/${d.id}`)}
      />
    </>
  )
}
