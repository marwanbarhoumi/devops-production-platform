// CI pipeline for devops-production-platform.
// Phase 2 (CI): toolchain, install, lint, type check, unit/API and integration tests, build.
// Phase 3 (DevSecOps): SonarQube quality gate, Trivy scans, image build, SBOMs, registry publishing.
// Agent setup, job configuration and GitHub webhook: jenkins/README.md. SonarQube, Trivy and
// publishing: security/README.md.
import org.jenkinsci.plugins.credentialsbinding.impl.CredentialNotFoundException

pipeline {
    // Provided by jenkins/agent/Dockerfile (Node.js 24, npm, git, Docker CLI talking to a DinD sidecar,
    // SonarScanner CLI, Trivy).
    agent { label 'linux && nodejs24 && docker' }

    options {
        // Image builds and the first Trivy database download need more than the Phase 2 stages.
        timeout(time: 45, unit: 'MINUTES')
        timestamps()
        // Builds of the same branch queue up instead of running in parallel; Jenkins merges queued
        // triggers into one build, so a burst of pushes does not create a backlog.
        disableConcurrentBuilds()
        buildDiscarder(logRotator(numToKeepStr: '30', artifactNumToKeepStr: '10'))
        skipDefaultCheckout(true)
    }

    triggers {
        // Fired by GitHub webhooks posted to <JENKINS_URL>/github-webhook/ (GitHub plugin).
        githubPush()
    }

    environment {
        CI = 'true'
        NO_COLOR = '1'
        NPM_CONFIG_AUDIT = 'false'
        NPM_CONFIG_FUND = 'false'
        NPM_CONFIG_UPDATE_NOTIFIER = 'false'
        // JUnit XML: reports/junit/unit/<service>.xml and reports/junit/integration/<service>.xml
        JUNIT_REPORTS_DIR = 'reports/junit'
        // Names and labels the disposable integration-test database so only this build's container is removed.
        CI_RUN_ID = "${env.BUILD_TAG}"
        // LCOV for SonarQube: reports/coverage/<unit|integration>/<service>/lcov.info
        COVERAGE_REPORTS_DIR = 'reports/coverage'
        // Local SonarQube (security/sonarqube), published on the host's 127.0.0.1:9100.
        SONAR_HOST_URL = 'http://host.docker.internal:9100'
        // <IMAGE_PREFIX>/<service>:<sha12> and :<version>-<sha7> (scripts/ci/images.mjs).
        IMAGE_REGISTRY = 'ghcr.io'
        IMAGE_PREFIX = 'ghcr.io/marwanbarhoumi/devops-production-platform'
        // Jenkins "Username with password" credential for IMAGE_REGISTRY; publishing is skipped without it.
        REGISTRY_CREDENTIALS_ID = 'container-registry'
    }

    stages {
        stage('Checkout') {
            steps {
                script {
                    def scmVars = checkout scm
                    env.GIT_COMMIT = scmVars.GIT_COMMIT
                    env.GIT_COMMIT_SHORT = scmVars.GIT_COMMIT.take(12)
                    def branch = env.BRANCH_NAME ?: (scmVars.GIT_BRANCH ?: 'detached')
                    // "origin/main" (Pipeline job) or "main" (multibranch) -> "main"; used to gate publishing.
                    env.SOURCE_BRANCH = branch.replaceFirst('^origin/', '')
                    currentBuild.description = "${branch} @ ${env.GIT_COMMIT_SHORT}"
                    echo "Checked out ${branch} at commit ${env.GIT_COMMIT}"
                }
            }
        }

        stage('Verify Toolchain') {
            steps {
                sh '''
                    command -v node >/dev/null 2>&1 || { echo "ERROR: Node.js is not installed on agent ${NODE_NAME}"; exit 1; }
                    node scripts/ci/verify-toolchain.mjs --security-tools
                '''
            }
            post {
                failure { echo 'Toolchain check failed: the agent lacks a required tool or version. See jenkins/README.md > Troubleshooting.' }
            }
        }

        stage('Install Dependencies') {
            options { timeout(time: 10, unit: 'MINUTES') }
            steps {
                sh 'npm ci'
            }
            post {
                failure { echo 'npm ci failed: check that package-lock.json is committed and in sync with package.json, and that the agent can reach the npm registry.' }
            }
        }

        stage('Lint') {
            steps {
                sh 'npm run lint'
            }
            post {
                failure { echo 'Lint failed: run "npm run lint" locally ("npm run lint:fix" fixes many issues).' }
            }
        }

        stage('Type Check') {
            steps {
                sh 'npm run typecheck'
            }
            post {
                failure { echo 'Type check failed: run "npm run typecheck" locally.' }
            }
        }

        stage('Unit & API Tests') {
            steps {
                sh 'npm run test:ci'
            }
            post {
                always {
                    junit testResults: 'reports/junit/unit/*.xml', allowEmptyResults: false
                }
                failure { echo 'Unit/API tests failed: see the Tests tab for the failing cases, or run "npm test" locally.' }
            }
        }

        stage('Integration Tests') {
            options { timeout(time: 10, unit: 'MINUTES') }
            steps {
                sh 'npm run test:integration:ci'
            }
            post {
                always {
                    // Backstop for aborted builds; removes only containers labelled with this build's CI_RUN_ID.
                    // Runs before junit, which throws when the tests never produced a report.
                    sh 'node scripts/ci/ephemeral-postgres.mjs cleanup'
                    junit testResults: 'reports/junit/integration/*.xml', allowEmptyResults: false
                }
                failure { echo 'Integration tests failed: run "npm run test:integration:ci" locally (needs Docker).' }
            }
        }

        stage('Build') {
            steps {
                sh 'npm run build'
            }
            post {
                success {
                    archiveArtifacts artifacts: 'services/*/dist/**', fingerprint: true, onlyIfSuccessful: true
                }
                failure { echo 'Build failed: run "npm run build" locally.' }
            }
        }

        stage('SonarQube Analysis') {
            options { timeout(time: 10, unit: 'MINUTES') }
            steps {
                // The scanner reads SONAR_TOKEN from the environment; sonar.qualitygate.wait=true
                // (sonar-project.properties) makes this step fail when the quality gate fails.
                withCredentials([string(credentialsId: 'sonarqube-token', variable: 'SONAR_TOKEN')]) {
                    sh '''
                        sonar-scanner \
                          -Dsonar.host.url="$SONAR_HOST_URL" \
                          -Dsonar.projectVersion="$(node -p "require('./package.json').version")" \
                          -Dsonar.scm.revision="$GIT_COMMIT"
                    '''
                }
            }
            post {
                success { echo "Quality gate passed: ${env.SONAR_HOST_URL.replace('host.docker.internal', 'localhost')}/dashboard?id=devops-production-platform" }
                failure { echo 'SonarQube failed: quality gate not passed (see the dashboard link above), or SonarQube is down / the sonarqube-token credential is missing. See security/README.md.' }
            }
        }

        stage('Trivy Filesystem Scan') {
            options { timeout(time: 10, unit: 'MINUTES') }
            steps {
                sh 'node scripts/ci/trivy-scan.mjs fs'
            }
            post {
                always { archiveArtifacts artifacts: 'reports/trivy/filesystem.json, reports/trivy/filesystem.txt', allowEmptyArchive: true }
                failure { echo 'Trivy found HIGH/CRITICAL issues in dependencies, secrets or Dockerfiles: see the BLOCKING lines above and security/README.md.' }
            }
        }

        stage('Build Images') {
            options { timeout(time: 15, unit: 'MINUTES') }
            steps {
                sh 'node scripts/ci/images.mjs build'
            }
            post {
                failure { echo 'Image build failed: run "docker build -f services/<service>/Dockerfile ." locally.' }
            }
        }

        stage('Scan Images') {
            options { timeout(time: 15, unit: 'MINUTES') }
            steps {
                sh 'node scripts/ci/images.mjs scan'
            }
            post {
                always {
                    archiveArtifacts artifacts: 'reports/trivy/image-*.json, reports/trivy/image-*.txt, reports/sbom/*.cdx.json, reports/images/manifest.json',
                        allowEmptyArchive: true, fingerprint: true
                }
                failure { echo 'Trivy found HIGH/CRITICAL vulnerabilities or secrets in an image: see the BLOCKING lines above and security/README.md.' }
            }
        }

        stage('Publish Images') {
            when { expression { env.SOURCE_BRANCH == 'main' } }
            steps {
                script {
                    try {
                        withCredentials([usernamePassword(credentialsId: env.REGISTRY_CREDENTIALS_ID,
                                usernameVariable: 'REGISTRY_USER', passwordVariable: 'REGISTRY_PASSWORD')]) {
                            // Throwaway Docker config: the registry login never lands in the agent's home.
                            sh '''
                                export DOCKER_CONFIG="$(mktemp -d)"
                                trap 'docker logout "$IMAGE_REGISTRY" >/dev/null 2>&1 || true; rm -rf "$DOCKER_CONFIG"' EXIT
                                printf '%s' "$REGISTRY_PASSWORD" | docker login "$IMAGE_REGISTRY" --username "$REGISTRY_USER" --password-stdin
                                node scripts/ci/images.mjs push
                            '''
                        }
                        archiveArtifacts artifacts: 'reports/images/published.json', fingerprint: true
                    } catch (CredentialNotFoundException e) {
                        echo "Publishing skipped: no Jenkins credential '${env.REGISTRY_CREDENTIALS_ID}'. " +
                             'The images were built and scanned but not pushed. See security/README.md > Publishing.'
                        currentBuild.description += ' (images not published)'
                    }
                }
            }
            post {
                failure { echo "Publishing failed: check the '${env.REGISTRY_CREDENTIALS_ID}' credential (token needs write:packages) and the registry status." }
            }
        }
    }

    post {
        success { echo "CI passed for ${env.GIT_COMMIT_SHORT ?: 'unknown commit'}." }
        failure { echo 'CI failed: open the first red stage above for the error and its hint.' }
        cleanup {
            // Removes this build's image tags from the Docker-in-Docker daemon (base layers stay cached).
            sh 'if [ -f scripts/ci/images.mjs ]; then node scripts/ci/images.mjs cleanup || true; fi'
            deleteDir()
        }
    }
}
