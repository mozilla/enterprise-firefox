# Generate CA key
openssl genrsa -out ca.key 4096

openssl req -x509 -new -nodes -key ca.key -sha256 -days 1825 \
  -out ca.pem -subj "/CN=EnterpriseTestsCA" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign"

openssl genrsa -out localhost.key 4096

openssl req -new -key localhost.key -out localhost.csr \
  -subj "/CN=localhost"

openssl x509 -req -in localhost.csr -CA ca.pem -CAkey ca.key \
  -CAcreateserial -out localhost.pem -days 825 -sha256 \
  -extfile <(printf "subjectAltName=DNS:localhost,IP:127.0.0.1")

# Create NSS database
LD_LIBRARY_PATH=obj-.../dist/bin/ obj-.../dist/bin/certutil  -A -n "EnterpriseTestsCA" -t "CT,," -i testing/enterprise/https/ca.pem -d testing/enterprise/https/ 
