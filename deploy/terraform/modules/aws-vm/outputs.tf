output "public_ip" {
  description = "Elastic IP. Point the DNS record of the domain here (A record)."
  value       = aws_eip.this.public_ip
}

output "instance_id" {
  description = "EC2 instance id."
  value       = aws_instance.this.id
}

output "data_volume_id" {
  description = "EBS volume with the database."
  value       = aws_ebs_volume.data.id
}

output "ansible_inventory" {
  description = "Inventory line for deploy/ansible (bootstrap_mode = base, or later updates)."
  value       = "onetime-1 ansible_host=${aws_eip.this.public_ip} ansible_user=ubuntu"
}
