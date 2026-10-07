FROM python:3.12-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DATA_DIR=/data \
    HOME=/tmp \
    TEXMFVAR=/tmp/texmf-var

# TeX Live: just the packages Jake's resume template needs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      texlive-latex-base texlive-latex-recommended texlive-latex-extra \
      texlive-fonts-recommended texlive-lang-english lmodern cm-super-minimal tzdata \
 && rm -rf /var/lib/apt/lists/* \
 && for f in fullpage.sty titlesec.sty marvosym.sty enumitem.sty fancyhdr.sty tabularx.sty glyphtounicode.tex english.ldf; do \
      kpsewhich "$f" >/dev/null || { echo "missing LaTeX file: $f"; exit 1; }; \
    done

WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY seed ./seed

# Fail the build if the seeded resume can't compile.
RUN python -m app.selftest

RUN useradd --uid 1000 --create-home --shell /usr/sbin/nologin app \
 && rm -rf /data && mkdir -p /data && chown app:app /data
USER app
VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=60s --timeout=5s --start-period=10s \
  CMD python -c "import urllib.request,sys; urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=4)" || exit 1

CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "2", "--threads", "4", "--timeout", "60", "app.wsgi:app"]
