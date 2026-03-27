FROM $DOCKER_IMAGE_PARENT

MAINTAINER release@mozilla.com

# We do want to install recommended packages.
RUN sed -i /APT::Install-Recommends/d /etc/apt/apt.conf.d/99taskcluster

VOLUME /builds/worker/checkouts

RUN mkdir /build
ADD system-setup.sh /tmp/system-setup.sh
RUN bash /tmp/system-setup.sh

RUN chown -R worker:worker /builds/worker/bin && chmod 755 /builds/worker/bin/*
ENV PATH $PATH:/builds/worker/bin

ENV           LANG          C.UTF-8
ENV           LC_ALL        C.UTF-8

# Set a default command useful for debugging
CMD ["/bin/bash", "--login"]
