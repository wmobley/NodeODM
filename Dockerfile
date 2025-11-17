FROM opendronemap/odm:latest
LABEL maintainer="Piero Toffanin <pt@masseranolabs.com>"

EXPOSE 3000

USER root
RUN apt-get update && \
    apt-get install -y curl gpg-agent ca-certificates nodejs npm unzip p7zip-full && \
    npm install -g nodemon && \
    ln -s /code/SuperBuild/install/bin/untwine /usr/bin/untwine && \
    ln -s /code/SuperBuild/install/bin/entwine /usr/bin/entwine && \
    ln -s /code/SuperBuild/install/bin/pdal /usr/bin/pdal


RUN mkdir /var/www

WORKDIR "/var/www"
COPY . /var/www

RUN npm install --production && mkdir -p tmp

ENTRYPOINT ["/usr/bin/node", "/var/www/index.js"]
