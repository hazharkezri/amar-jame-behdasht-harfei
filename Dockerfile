FROM node:22-slim
WORKDIR /app
COPY . .
RUN useradd -m app && mkdir -p data && chown -R app /app
USER app
EXPOSE 3000
CMD ["node","--no-warnings","server.js"]
