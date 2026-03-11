# -*- mode: ruby -*-
# vi: set ft=ruby :

dir_name = File.basename(Dir.pwd)

Vagrant.configure("2") do |config|
  config.vm.box = "cloud-image/ubuntu-24.04"
  config.vm.hostname = "cc-#{dir_name}"

  config.vm.provider :libvirt do |lv|
    lv.memory = 4096
    lv.cpus = 2
    lv.memorybacking :access, :mode => "shared"
  end

  config.vm.synced_folder ".", "/home/vagrant/#{dir_name}", type: "virtiofs"

  # Package Claude config on the host before uploading.
  # Vagrant's file provisioner can't handle broken symlinks (e.g. debug/latest),
  # so we tar with --exclude to skip them.
  config.trigger.before :up do |trigger|
    trigger.info = "Packaging Claude config..."
    trigger.run = {inline: "tar czf /tmp/vagrant-claude-config.tar.gz -C #{Dir.home} --exclude .claude/debug .claude .claude.json"}
  end

  config.vm.provision "file",
    source: "/tmp/vagrant-claude-config.tar.gz",
    destination: "/tmp/claude-config.tar.gz"

  config.vm.provision "shell", inline: <<-SHELL
    set -eux

    # Extract Claude config
    tar xzf /tmp/claude-config.tar.gz -C /home/vagrant/
    chown -R vagrant:vagrant /home/vagrant/.claude /home/vagrant/.claude.json
    rm -f /tmp/claude-config.tar.gz

    # Node.js via NodeSource
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs git

    # Claude Code (native installer, matches host install method)
    su - vagrant -c "curl -fsSL https://claude.ai/install.sh | bash"

    # Add ~/.local/bin to PATH for non-login shells (SSH commands)
    grep -q '.local/bin' /home/vagrant/.bashrc || echo 'export PATH="$HOME/.local/bin:$PATH"' >> /home/vagrant/.bashrc
  SHELL
end
