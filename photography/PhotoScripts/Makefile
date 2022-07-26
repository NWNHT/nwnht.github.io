default: exe

exe: process-photo.c libcJSON.a 
	gcc -Wall process-photo.c libcJSON.a -o $@

libcJSON.a: cJSON.o
	ar -rcv $@ $^

cJSON.o: cJSON.c
	gcc -c cJSON.c -o cJSON.o
