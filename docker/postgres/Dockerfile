# PostgreSQL 16 with pg_bigm — the spec §7.1 / §18 Q3.
#
# pg_bigm is not in the official image and has no Debian package, so it is compiled here.
# It indexes 2-grams, which is what makes a CJK character n-gram index work: pg_trgm's
# 3-grams over a 5-character line yield too few tokens to be selective.
FROM postgres:16-bookworm

ARG PG_BIGM_VERSION=1.2-20240606

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        build-essential postgresql-server-dev-16 curl ca-certificates; \
    curl -fsSL -o /tmp/pg_bigm.tar.gz \
        "https://github.com/pgbigm/pg_bigm/archive/refs/tags/v${PG_BIGM_VERSION}.tar.gz"; \
    tar -xzf /tmp/pg_bigm.tar.gz -C /tmp; \
    cd "/tmp/pg_bigm-${PG_BIGM_VERSION}"; \
    make USE_PGXS=1; \
    make USE_PGXS=1 install; \
    cd /; rm -rf /tmp/pg_bigm*; \
    apt-get purge -y --auto-remove build-essential postgresql-server-dev-16 curl; \
    rm -rf /var/lib/apt/lists/*

# pg_bigm requires its GUCs to be loadable; enabling similarity search needs the library.
RUN echo "shared_preload_libraries = 'pg_bigm'" >> /usr/share/postgresql/postgresql.conf.sample

COPY init/ /docker-entrypoint-initdb.d/
