/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Small, self-contained runtime image (see Dockerfile).
  output: 'standalone',
};

module.exports = nextConfig;
