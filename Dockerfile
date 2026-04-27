# Stage 1: Build frontend
FROM node:20-alpine AS frontend-build
WORKDIR /app
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ .
RUN npm run build

# Stage 2: Backend + frontend static files
FROM python:3.12-slim
WORKDIR /app

ARG GIT_COMMIT=unknown
ARG APP_VERSION=1.0.0
ENV APP_VERSION=$APP_VERSION
ENV APP_COMMIT=$GIT_COMMIT

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ .
COPY --from=frontend-build /app/dist /app/static

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
