// CI pipeline for devops-production-platform (Phase 2).
// Agent setup, job configuration and GitHub webhook: see jenkins/README.md.
pipeline {
    // Provided by jenkins/agent/Dockerfile (Node.js 24, npm, git, Docker CLI talking to a DinD sidecar).
    agent { label 'linux && nodejs24 && docker' }

    options {
        timeout(time: 30, unit: 'MINUTES')
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
    }

    stages {
        stage('Checkout') {
            steps {
                script {
                    def scmVars = checkout scm
                    env.GIT_COMMIT = scmVars.GIT_COMMIT
                    env.GIT_COMMIT_SHORT = scmVars.GIT_COMMIT.take(12)
                    def branch = env.BRANCH_NAME ?: (scmVars.GIT_BRANCH ?: 'detached')
                    currentBuild.description = "${branch} @ ${env.GIT_COMMIT_SHORT}"
                    echo "Checked out ${branch} at commit ${env.GIT_COMMIT}"
                }
            }
        }

        stage('Verify Toolchain') {
            steps {
                sh '''
                    command -v node >/dev/null 2>&1 || { echo "ERROR: Node.js is not installed on agent ${NODE_NAME}"; exit 1; }
                    node scripts/ci/verify-toolchain.mjs
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
    }

    post {
        success { echo "CI passed for ${env.GIT_COMMIT_SHORT ?: 'unknown commit'}." }
        failure { echo 'CI failed: open the first red stage above for the error and its hint.' }
        cleanup { deleteDir() }
    }
}
