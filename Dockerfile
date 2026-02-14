FROM --platform=linux/amd64 mcr.microsoft.com/devcontainers/universal:2

ARG TZ
ENV TZ="$TZ"

ARG CLAUDE_CODE_VERSION=latest

# Remove expired Yarn GPG key/repo from base image
RUN rm -f /etc/apt/sources.list.d/yarn.list /usr/share/keyrings/yarn-keyring.gpg 2>/dev/null || true

# Persist bash history
ARG USERNAME=codespace
RUN SNIPPET="export PROMPT_COMMAND='history -a' && export HISTFILE=/commandhistory/.bash_history" \
  && mkdir -p /commandhistory \
  && touch /commandhistory/.bash_history \
  && chown -R $USERNAME /commandhistory \
  && echo "$SNIPPET" >> "/home/$USERNAME/.bashrc" \
  && echo "$SNIPPET" >> "/home/$USERNAME/.zshrc"

# Create claude config directory
RUN mkdir -p /home/codespace/.claude && \
  chown -R codespace:codespace /home/codespace/.claude

# Install git-delta
ARG GIT_DELTA_VERSION=0.18.2
RUN ARCH=$(dpkg --print-architecture) && \
  wget -q "https://github.com/dandavison/delta/releases/download/${GIT_DELTA_VERSION}/git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb" && \
  dpkg -i "git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb" && \
  rm "git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb"

# Install IaC tools (as root for system-wide installation)
# Terraform (direct binary — apt repo doesn't have packages for focal)
ARG TERRAFORM_VERSION=1.10.5
RUN curl -sL "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_amd64.zip" -o terraform.zip && \
    unzip -q terraform.zip && mv terraform /usr/bin/terraform && \
    rm terraform.zip

# kubectl
RUN curl -sLO "https://dl.k8s.io/release/$(curl -sL https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" && \
    chmod +x kubectl && mv kubectl /usr/local/bin/kubectl.real

# AWS CLI v2
RUN curl -s "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o awscliv2.zip && \
    unzip -q awscliv2.zip && ./aws/install --bin-dir /usr/local/bin/aws-real && \
    rm -rf awscliv2.zip aws/

# Install Claude Code as non-root
USER codespace
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

# Force git to use HTTPS instead of SSH (SSH can't traverse HTTP proxy)
RUN git config --global url."https://github.com/".insteadOf "git@github.com:" && \
    git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"

# Install tool proxy wrapper scripts and static token
USER root
COPY .proxy-token /etc/tool-proxy-token
COPY git-proxy-wrapper.sh /usr/local/bin/git
COPY gh-proxy-wrapper.sh /usr/local/bin/gh
COPY terraform-proxy-wrapper.sh /usr/local/bin/terraform
COPY kubectl-proxy-wrapper.sh /usr/local/bin/kubectl
COPY aws-proxy-wrapper.sh /usr/local/bin/aws
RUN chmod 644 /etc/tool-proxy-token && \
    chmod +x /usr/local/bin/git /usr/local/bin/gh \
             /usr/local/bin/terraform /usr/local/bin/kubectl /usr/local/bin/aws

# Copy verification script
COPY verify.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/verify.sh

USER codespace
