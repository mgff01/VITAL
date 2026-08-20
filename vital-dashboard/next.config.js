/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ['serialport', '@serialport/bindings-cpp', 'node-gyp-build'],
  },
};

module.exports = nextConfig;
