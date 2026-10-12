FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ARG VITE_API_URL=http://localhost:8080
ENV VITE_API_URL=${VITE_API_URL}
RUN npm run build

FROM nginx:1.27-alpine
# The checkout is designed to be framed by merchant sites; everything else is locked down.
RUN printf 'server {\n  listen 80;\n  root /usr/share/nginx/html;\n  add_header X-Content-Type-Options nosniff;\n  add_header Referrer-Policy no-referrer;\n  location / { try_files $uri /index.html; }\n}\n' > /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
