FROM opendronemap/odm:latest
LABEL maintainer="Piero Toffanin <pt@masseranolabs.com>"

EXPOSE 3000

USER root
RUN apt-get update && \
    apt-get install -y curl gpg-agent ca-certificates nodejs npm unzip p7zip-full \
        python3-dateutil python3-repoze.lru python3-psutil python3-pip && \
    python3 -m pip install --no-cache-dir vmem && \
    npm install -g nodemon && \
    ln -s /code/SuperBuild/install/bin/untwine /usr/bin/untwine && \
    ln -s /code/SuperBuild/install/bin/entwine /usr/bin/entwine && \
    ln -s /code/SuperBuild/install/bin/pdal /usr/bin/pdal


RUN mkdir /var/www

WORKDIR "/var/www"
COPY . /var/www

RUN npm install --production && mkdir -p tmp

COPY nodeodm-entry.sh /usr/local/bin/nodeodm-entry.sh
RUN chmod +x /usr/local/bin/nodeodm-entry.sh

ENTRYPOINT ["/usr/local/bin/nodeodm-entry.sh"]
