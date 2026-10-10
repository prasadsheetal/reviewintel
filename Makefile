.PHONY: install synth deploy destroy test deploy-frontend

# Install all dependencies (CDK, frontend, Python lambda deps for local checks)
install:
	cd cdk && npm install
	cd frontend && npm install
	python3 -m pip install -r lambdas/processor/requirements.txt -r lambdas/api/requirements.txt -r worker/requirements.txt

# Synthesize the CloudFormation template (no AWS credentials needed for synth)
synth:
	cd cdk && npx cdk synth

# Full deploy: build frontend, deploy CDK stack, then sync the built site to S3
deploy:
	cd frontend && npm run build
	cd cdk && npx cdk deploy --require-approval never
	$(MAKE) deploy-frontend

# Sync the built frontend to the hosting bucket (bucket name from stack outputs)
deploy-frontend:
	@BUCKET=$$(aws cloudformation describe-stacks --stack-name ReviewIntelStack \
		--query "Stacks[0].Outputs[?OutputKey=='SiteBucketName'].OutputValue" --output text); \
	aws s3 sync frontend/dist s3://$$BUCKET --delete
	@echo "Frontend deployed. CloudFront URL:"
	@aws cloudformation describe-stacks --stack-name ReviewIntelStack \
		--query "Stacks[0].Outputs[?OutputKey=='SiteUrl'].OutputValue" --output text

# Tear everything down (stops all billing; run when not demoing)
destroy:
	cd cdk && npx cdk destroy --force

# Local checks: compile Python, typecheck + build frontend skeleton
test:
	python3 -m py_compile lambdas/processor/handler.py lambdas/api/handler.py worker/ingest.py
	cd frontend && npm run build
	@echo "Local checks passed."
